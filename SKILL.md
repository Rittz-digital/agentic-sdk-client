---
name: agentic-sdk-client
description: Integrate the Hanexis Agentic SDK into an application — the turn contract, business rules, charts and tables, and error handling, plus a pointer to the guide for your database.
---

# Integrating the Agentic SDK

You are wiring an application to the Agentic SDK service. The SDK does the reasoning; your
application owns the database.

**The one rule that explains everything else:** the SDK never holds a database connection. It sends
a query request; you run it and return rows. Every other decision follows from that split.

## Pick your database guide

The integration has two halves. This file is the half that is the same whatever you store data in.
The other half — extracting your schema, executing queries, and hardening them — depends entirely
on your database:

| Database | Guide | Status |
| --- | --- | --- |
| MongoDB (Mongoose) | [SKILL-mongodb.md](./SKILL-mongodb.md) | Supported |
| Postgres / MySQL / SQL Server | — | Not yet |

**On SQL:** the agent is currently given `mongo_find` and `mongo_aggregate` tools, so the queries it
writes are MongoDB filter objects and aggregation pipelines. A SQL application cannot implement that
by translating — it would be parsing Mongo syntax into SQL, which is not the intended design. SQL
support means a different tool set inside the SDK and a correspondingly different callback. Until
then, treat "bring any database" as aspiration rather than a description of today.

## What you write

Read the database guide for the details; the shape is:

1. **A schema descriptor** — your models' field names and types. *(database-specific extraction)*
2. **A query callback** — the one function that touches your database. *(database-specific)*
3. **A turn call** — sends the schema, the scope grant and the callback URL. *(below)*
4. **A route** exposing the callback over HTTP. *(below)*

Budget roughly **1,000 lines** for a real integration. Most of it is query hardening, not the
contract — see the database guide for why.

---

## 1. The descriptor's shape

Structure only. Field names, types, enums, nesting — no descriptions, no roles, no relationships.
The SDK infers those and caches the result per schema shape.

```ts
import type { SchemaSourceDescriptor } from "@hanexis/agentic-sdk-client";

function getSchema(): SchemaSourceDescriptor {
  return {
    connectionId: "my-app-primary",
    collections: [
      {
        modelName: "Order",
        collectionName: "orders",
        looseSchema: false,
        fields: [
          { name: "orderNumber", type: "string", required: true, indexed: true },
          { name: "status", type: "string", required: true, indexed: true,
            enumValues: ["draft", "shipped", "cancelled"] },
          { name: "grandTotal", type: "number", required: true, indexed: false },
        ],
        undiscoverableFields: [],
      },
    ],
    fieldSemantics: BUSINESS_RULES,   // §2
  };
}
```

`role`, `description` and `relationships` are optional. Supply one and the SDK treats it as a stated
fact and will not overwrite it; omit it and the SDK fills it in — which is usually what you want,
because inference reads your real data and a description typed six months ago does not.

**Send only the collections you also grant** (see §3). Describing more than you grant means the SDK
infers and caches collections the agent can never read — wasted work, and it weakens the boundary:
a bare descriptor omits `role`, so the SDK infers one, and it will happily label your internal
tables `business-data`. A collection the SDK was never told about cannot reach a prompt whatever
role it might have guessed.

## 2. Business rules — `fieldSemantics`

The one place hand-written knowledge belongs. Keyed `"Collection.field"`, or
`"Collection.parent.child"` for nested paths; reaches the agent's prompt as `MEANS: ...`.

Only for conventions **the data cannot reveal** — a decision your business made that no document
records. Not for describing your schema; inference does that better.

```ts
const BUSINESS_RULES: Record<string, string> = {
  "Order.branch":
    "An order with NO branch is not unassigned — it belongs to the branch flagged isMain. Never " +
    "report branch-less orders as their own bucket; the per-branch figures then fail to reconcile " +
    "with the total. To find which branch is main, query the company record directly — a plain " +
    "id-resolve returns names only, not that flag.",
  "Order.fullyBilled":
    "Some orders lack this field entirely, and an absent field does not match `false` — count " +
    "unbilled orders with `{$ne: true}`, not `{false}`.",
};
```

Both came from a real wrong answer, and that is the bar: **write a rule when you have seen the agent
get something wrong, not in anticipation.** Every entry is knowledge the SDK is no longer being
asked to derive, so a growing list quietly turns inference back into a hand-authored schema.

Two things decide whether a rule works:

- **State the consequence, not just the fact.** *"count with `$ne: true`, because an absent field
  does not match `false`"* survives contact with a question. *"This field may be absent"* gets read
  past.
- **Make it actionable.** A rule naming a flag the agent has no way to fetch is unfollowable — it
  will understand the rule, fail to apply it, and write a footnote apologising instead. Say which
  query gets the value.

Changing these re-runs inference automatically; the cache key covers the rules as well as the
fields.

## 3. Running a turn

```ts
const client = new AgenticSdkClient({ sdkUrl, apiKey, sessionScopeStore });

const result = await client.runTurn({
  schema: getSchema({ only: ORDER_MODULE_COLLECTIONS }),
  allowedCollections: [...ORDER_MODULE_COLLECTIONS],   // same set as the schema
  queryCallbackUrl: `${APP_URL}/api/agentic-sdk/query-callback`,
  callbackAuthToken: process.env.CALLBACK_TOKEN!,
  scopeDescription: "the Order module",
  currencySymbol: "₹",
  history: historyToAgentMessages(previousMessages),
  userMessage,
  signal,                                              // wire to your stop button
  onReasoningStep: (step) => showThinking(step.text),
  onTextChunk: (chunk) => appendToReply(chunk),
});
// result: { replyText, toolCalls }
```

- **One constant for both** `schema` and `allowedCollections` — deriving them separately is how they
  drift.
- **The assistant names itself.** There is no `assistantName` option: the agent identifies itself
  as Hanexis, fixed in its own prompt. Present the reply under your own branding if you like — that
  is your UI's business — but the service does not rename itself per caller.
- **`currencySymbol` matters.** Money fields are just numbers on the wire. Without it the agent
  guesses, and the same figure appears as `$4,477,084.02` in one answer and `₹4,477,084` in the next.
- **Skip `outOfScopeTopics` unless you have a hard policy line.** Scope already derives from
  `allowedCollections`, so the agent refuses what it genuinely lacks data for and explains which
  data it lacks. A hand-written keyword list is worse than redundant: a rule matching `employee`
  refused "which employee placed the most orders", which an order's own fields answer.
- **History is yours.** The SDK is stateless per turn; pass the relevant slice each time.

## 4. The callback route

Thin, and it must share one object with the client:

```ts
export const sessionScopeStore = createInMemorySessionScopeStore();   // exported from run-sdk-turn

const handler = createQueryCallbackHandler({
  callbackAuthToken: process.env.CALLBACK_TOKEN!,
  sessionScopeStore,                    // SAME instance the client uses
  execute: executeQueryCallback,        // your database-specific function
});

export async function POST(request) {
  const body = await request.json().catch(() => null);
  const { status, body: responseBody } = await handler.handle(request.headers.get("authorization"), body ?? {});
  return Response.json(responseBody, { status });
}
```

The client registers each turn's scope into that store immediately before the request fires, and the
callback reads it back when the SDK calls in. Two instances means every callback is rejected as an
unknown session.

Whatever your database, `execute` must:

- **Re-check the scope.** `allowedCollections` is handed to you; enforce it rather than assuming the
  request is already in scope. This is your boundary, not the SDK's.
- **Enforce read-only** at the boundary, before execution — never by trusting the request.
- **Bound every query** with a server-side timeout and a row cap.
- **Return `totalMatching`** — the true count matching the filter, not the page size. Without it the
  agent cannot tell a complete answer from the first page of one: observed live, it received
  `returnedCount: 20` (its own page limit) and reported "20 orders" when the real total was 34.

## 5. Charts and tables

Both arrive as tool calls in `result.toolCalls`. The SDK validates and returns a **spec**; your UI
draws it. The SDK renders nothing.

```ts
for (const call of result.toolCalls) {
  if (call.name === "renderChart") drawChart(call.result.chartSpec);
  if (call.name === "renderTable") drawTable(call.result.tableSpec);
}
```

A chart spec carries `type`, `title`, `series[]` of `{category, value}` points, and formatting hints
(`valueFormat`: `currency` | `number` | `percent`). A table spec carries `columns` and `rows`
already resolved from the underlying query.

- **A rejected spec is normal.** `rendered: false` comes back with a reason when a spec is invalid or
  contradicts the data behind it. The agent reads that and corrects or answers in text — your UI just
  draws nothing.
- **Render tables as real tables.** `renderTable` exists so long results are not written as markdown,
  where they hit the reply's length limit and truncate mid-row.

## 5.5. Letting the agent ask the user something — `askUser`

Not specific to charts or products. Any time the agent would otherwise have to guess between a few
reasonable options, or needs one piece of information only the user can supply, it calls this ONE
generic tool — offering a chart type when several would fit, disambiguating two same-named records,
confirming before something consequential, collecting an email address, anything of that shape.

```ts
for (const call of result.toolCalls) {
  if (call.name === "askUser") showPicker(call.result.awaitingInput);
}
// awaitingInput: { prompt, options: [{ id, label, description?, value? }], allowFreeText, freeTextPlaceholder? }
```

Build **one generic picker component** for this — a prompt, a button per option, and (unless
`allowFreeText` is `false`) a free-text box for an answer that isn't one of the options. Do not build
a separate picker per use case; that is exactly the duplication this tool exists to avoid.

- **`value` is opaque and optional.** The agent may attach a ready-to-use payload to an option — most
  usefully a fully-built chart spec for that chart type, computed from data it already gathered this
  turn — so picking the option costs no further lookup. Your UI does nothing with it except echo it
  back; treat it as an arbitrary JSON blob.
- **Only the LAST message's `askUser` call matters.** One from an earlier turn was already answered or
  abandoned; re-surfacing it lets the user answer a question that no longer has anywhere to go.
- **Round-tripping the pick.** The turn contract (§3) is a flat `userMessage` string with no separate
  side-channel field, so when the user picks an option, send a message like `"[User picked: <label>]"`
  followed by `JSON.stringify(value)` on the next line if the option had one — appended to (or in place
  of) whatever `userMessage` you'd otherwise send. The agent reads that prefix as the answer to its own
  question, not a new one, and reuses the `value` verbatim rather than recomputing it. Typing free text
  instead just sends that text as an ordinary message — nothing special to do there.

## 5.6. Naming the conversation (optional, and not the SDK's job)

Threads — and therefore thread titles — are a storage concept, and the SDK holds no database and no
thread id anywhere in its contract (§ intro). If your UI lists past conversations by name, that
naming is entirely yours to build, the same way persistence and history windowing are (§3, "History
is yours"). This is the pattern that works well, if you want one:

- **A second, separate, cheap model call** — not part of `runTurn`, not blocking the real answer.
  Summarize the user's first message into a short title, `reasoning: "none"`, tight timeout (a title
  is cosmetic and must never be what makes a turn feel slow).
- **Fire it after the reply is already sent**, not awaited inline — the thread list just reflects the
  new title whenever it's next fetched. Awaiting it before closing the response holds up everything
  the user is actually waiting on for a purely decorative label.
- **Fall back to a truncated copy of the message** on any failure (missing key, rate limit, malformed
  response) — never fail the send over a title.
- **Retry titling while the title still says nothing** — a thread opened with "hi" has no topic to
  summarize yet; recognize that case (a fixed placeholder title, e.g. "Just saying hi", is simplest)
  and try again once a real question arrives, rather than generating from the first message only and
  leaving every greeting-opened thread mistitled forever.
- **Never title off an `askUser` pick.** A picked option's label (e.g. "Bar chart") is a UI button's
  text, not something the user said about their actual topic — generating a title from it renames the
  thread away from what it's really about. Skip titling whenever the message being sent is a pick
  response (you already have this signal: it is exactly the case carrying the `"[User picked: ...]"`
  round-trip text from §5.5, so gate title generation on that being absent, not on message content).

## 6. Errors

```ts
catch (err) {
  if (err instanceof AgentRefusedError) {
    // Not a failure: out of scope. `.module` names the topic. Render as a normal declined reply.
  }
  if (err instanceof AgentTurnError) {
    show(err.userMessage);   // safe for users — no env vars, no internal URLs, no CLI commands
    log(err.message);        // operator detail, for logs only
    // err.toolCalls holds whatever ran before the failure, so a failed turn stays debuggable
  }
}
```

Keep that split. Observed live, a 401 showed an end user a paragraph telling them to run a CLI
command and check an env var — instructions they could not act on and should never have seen.

## Cancellation

Pass an `AbortSignal`. Aborting stops the turn and releases its capacity immediately — wire it to
whatever "stop" control your UI has.

## Checklist (database-neutral)

- [ ] `schema` and `allowedCollections` come from one constant
- [ ] `fieldSemantics` holds only rules the data cannot reveal — short, actionable, each with its consequence
- [ ] Same `sessionScopeStore` instance in client and route
- [ ] `currencySymbol` set if any field is money
- [ ] `totalMatching` returned on every query
- [ ] Chart and table specs rendered by your UI
- [ ] `askUser` has one generic picker (options + free text) — not a per-case component
- [ ] Thread titling (if you have it) is your own cheap, non-blocking, fire-after-reply call — never generated from an `askUser` pick
- [ ] `AgentRefusedError` renders as a normal reply; only `userMessage` shown to users

Then work through the checklist in your database guide — that is where the query-level requirements
live.
