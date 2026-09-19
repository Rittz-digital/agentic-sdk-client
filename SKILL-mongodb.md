---
name: agentic-sdk-client-mongodb
description: Implement the Agentic SDK query callback for MongoDB via Mongoose — schema extraction, the callback, and the query hardening LLM-written queries need.
---

# Agentic SDK — MongoDB / Mongoose

The database-specific half of the integration. Read [SKILL.md](./SKILL.md) first for the parts that
are the same whatever you store data in — the turn contract, business rules, charts and tables,
errors.

**Why this is its own guide:** the agent is given `mongo_find` and `mongo_aggregate` tools, so the
queries it writes are MongoDB filter objects and aggregation pipelines. Your callback receives them
in that form and executes them as such. That is not a detail you can translate as you read — a
Postgres application needs a different tool set on the SDK side, not a translation layer here.

## The shape of an integration

Five files. This is a real, working layout — adapt the paths, keep the separation.

```
lib/ai/sdk-client/
  descriptor.ts      # your models -> the SDK's schema shape           (~130 lines)
  execute-query.ts   # the ONE function that touches your database     (~280 lines)
  run-sdk-turn.ts    # sends schema + scope + callback URL             (~120 lines)
lib/ai/shared/
  schema-extractor.ts       # ORM schema -> field names and types      (~130 lines)
  mongo-query-validator.ts  # query hardening (see §3 — the big one)   (~500 lines)
app/api/.../query-callback/route.ts   # exposes execute-query over HTTP  (~30 lines)
```

Budget roughly **1,000 lines**. Most of it is §3 — not because the contract is complicated, but
because queries written by a language model need guarding in ways hand-written ones do not.

---

## 1. Extract the schema — `schema-extractor.ts`

Walk your ORM and emit field names, types, required/indexed flags, enum values, and nesting.
Nothing semantic.

```ts
export function extractCollectionSchema(model): { modelName; collectionName; fields; looseSchema } {
  const fields = [];
  model.schema.eachPath((path, schemaType) => {
    if (path === "__v") return;
    fields.push(toSchemaField(path, schemaType));  // recurse into nested objects and arrays
  });
  return { modelName: model.modelName, collectionName: model.collection.collectionName, fields, looseSchema: ... };
}
```

Two things that are easy to get wrong:

- **Recurse into arrays of subdocuments.** On Mongoose the nested schema hangs off the array path's
  `.schema`, *not* `.caster.schema`. Reading the wrong one silently yields zero nested fields, so
  `Order.items[].rateMode` simply never reaches the agent and it cannot reason about line items.
- **Carry `enumValues` through.** An enum tells the agent the exact set of valid filter values.
  Without it, it guesses at status names and quietly returns nothing.

Keep this file free of any business knowledge — it should import no model and know no field names.
That is what makes it reusable across connections.

## 2. The query callback — `execute-query.ts`

The only place your database is used. Structure it as: **resolve → validate → execute → mask**.

```ts
export async function executeQueryCallback(request, allowedCollections): Promise<QueryCallbackResult> {
  const collection = resolveCollectionName(request.collection) ?? request.collection;
  if (request.kind !== "find" && request.kind !== "aggregate") {
    return { found: false, error: `Unsupported query kind: "${request.kind}"` };
  }

  const query = coerceJsonStringQuery(request.query);        // §3
  const validation = validateScopedMongoRequest({ collection, allowedResourceIds: allowedCollections, kind: request.kind, filterOrPipeline: query });
  if (!validation.ok) return { found: false, error: validation.reason };

  const model = await getModel(collection);
  const filter = normalizeMongoRegexes(query ?? {});          // §3
  const docs = await withLooseTextFallback(filter, (f) =>     // §3
    model.find(coerceIsoDateStrings(f))
      .sort(request.sort ?? { _id: -1 })                      // never rely on natural order
      .skip(clampSkip(request.skip))
      .limit(clampLimit(request.limit))
      .select(sanitizeProjectionFields(request.fields)?.join(" ") ?? {})
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean(),
    getStringFieldNames(model));

  const totalMatching = await model.countDocuments(filter).maxTimeMS(QUERY_TIMEOUT_MS);
  return { found: docs.length > 0, returnedCount: docs.length, totalMatching, documents: maskIdentity(docs) };
}
```

Non-obvious requirements, each from a real failure:

- **Re-check scope here.** `allowedCollections` is handed to you — enforce it rather than assuming
  the request is already in scope. This is your boundary, not the SDK's.
- **Return `totalMatching`.** The true count for the filter, not the page size. Without it the
  agent cannot tell a complete answer from the first page of one: observed live, it received
  `returnedCount: 20` (its own page limit) and reported "20 orders" when the real total was 34.
- **Default the sort.** An unsorted `find` + `limit` returns an arbitrary subset, and "most recent"
  questions then get an arbitrary row. Default to `{_id: -1}` when no sort is given.
- **Support `skip`.** Without it there is no way to reach page two, because your limit is capped
  server-side. The agent will otherwise burn a turn inventing `$skip` tricks and time out.
- **Mask identity before returning.** Anything that identifies your client should be rewritten on
  the way out, in the callback, not in the SDK. The SDK is shared; that knowledge is yours.

### The route

Thin, and it must share one object with the client:

```ts
export const sessionScopeStore = createInMemorySessionScopeStore();   // exported from run-sdk-turn

const handler = createQueryCallbackHandler({
  callbackAuthToken: process.env.CALLBACK_TOKEN!,
  sessionScopeStore,                    // SAME instance the client uses
  execute: executeQueryCallback,
});

export async function POST(request) {
  const body = await request.json().catch(() => null);
  const { status, body: responseBody } = await handler.handle(request.headers.get("authorization"), body ?? {});
  return Response.json(responseBody, { status });
}
```

The client registers each turn's scope into that store immediately before the request fires, and
the callback reads it back when the SDK calls in. Two instances means every callback is rejected as
an unknown session.

## 3. Query hardening — the part that is bigger than you expect

Roughly half the integration. **Most of it is not security** — it is the difference between how a
language model writes a query and how a person does.

**Security (non-negotiable).** Reject writes and code execution at the tool boundary, before
execution, never by trusting the request. In Mongo terms: `$out`, `$merge`, `$function`, `$where`,
`$accumulator`, walked recursively — a `$merge` nested inside `$facet` is exactly as dangerous as a
top-level one. Cap rows, and use a **server-side** timeout (`maxTimeMS`), not a client-side abort
that leaves the query running.

**Projection.** Re-sanitize field lists. `-partyName` in a Mongoose `.select()` flips an inclusion
projection into an exclusion — it changes what the query *means*, not just which columns return.
Reject `$`, `-` and `+` prefixes. Projection also matters for cost: a full document with every
nested array runs ~1,200 tokens, so a 50-row unprojected page is ~60,000 tokens and minutes of
reading.

**Then the LLM-specific repairs**, each earning its place:

- **Stringified arguments.** Models sometimes send `"[{\"$match\":...}]"` — the JSON as a *string* —
  and then retry the identical malformed shape. Parse it. Handle truncation too: a pipeline missing
  its closing `]` is recoverable by appending the brackets the text already implies.
- **Regex normalization.** Models write non-portable inline flags (`(?i)`) that Mongo rejects, and
  fragmented word-boundary patterns (`\bfoo\b.*\bbar\b`) that cannot match a real compound name.
  Rewrite both.
- **Loosen-on-empty retry.** When an exact filter returns nothing, retry with the term tokenized,
  then against every other string field on the collection. This is what actually fixes "it queried
  `companyName` when it meant `partyName`" — without a hardcoded field list, and without depending
  on the model noticing its own miss. It often does not: it repeats the "not found" conclusion on
  the follow-up instead of querying again.
- **ISO date strings.** Coerce to real dates, or every date comparison silently matches nothing.

**Do not pre-convert ids.** Mongoose already casts a 24-character hex string to an ObjectId when
the schema says the path is one. Constructing the ObjectId yourself risks a constructor-identity
mismatch that Mongoose then refuses outright — turning a working query into a hard error. Verify
what your driver already does before adding a coercion layer.

## Checklist (MongoDB-specific)

Run this alongside the database-neutral checklist in [SKILL.md](./SKILL.md).

- [ ] Extractor recurses into arrays of subdocuments (`.schema`, not `.caster.schema`) and carries `enumValues`
- [ ] Callback re-checks scope and enforces read-only itself
- [ ] `$out`, `$merge`, `$function`, `$where`, `$accumulator` rejected at ANY depth, including inside `$facet`
- [ ] `totalMatching` returned on every `find`
- [ ] Default sort (`{_id: -1}`), `skip`, and a validated projection all supported
- [ ] Server-side `maxTimeMS`, not a client-side abort
- [ ] Stringified-JSON, regex-normalization, loosen-on-empty and ISO-date coercions in place
- [ ] No hand-rolled ObjectId construction — let Mongoose cast
- [ ] Identity masking applied in the callback, not the SDK
