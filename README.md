# @hanexis/agentic-sdk-client

Thin client for the standalone Hanexis Agentic AI SDK service. Handles the HTTP/streaming
plumbing so an integration is three pieces instead of hand-rolling `fetch` + NDJSON parsing +
session tracking: **describe your schema**, **implement one query function**, **call `runTurn`**.

The SDK itself never touches your database — every query it needs comes back through your own
callback endpoint you implement below.

## Using this with a coding agent

```bash
npx @hanexis/agentic-sdk-client --skill
```

Writes two integration guides into your project (`.claude/skills/` by default, or
`--target=cursor|copilot|agents`) so your coding agent knows how to wire this package up:

- **SKILL.md** — the database-neutral half: the turn contract, what belongs in `fieldSemantics`,
  rendering the charts and tables a turn returns, error handling.
- **SKILL-mongodb.md** — schema extraction, the query callback, and the query hardening that
  LLM-written queries need.

They describe the contract only; none of the SDK's internals. **MongoDB via Mongoose is the only
database covered today** — the agent writes Mongo filters and aggregation pipelines, so a SQL
application needs a different tool set on the SDK side rather than a translation layer in the
callback.

## Install

```bash
npm install @hanexis/agentic-sdk-client
```

## 1. Get an API key

Ask whoever runs your SDK instance to issue you one — see that deployment's own key-management
tooling. You'll get a key (typically looking like `ask_...`); store it as a secret, never commit
it.

## 2. Describe your schema

**You pass your models. That is all.** Field names and types, extracted mechanically — no
descriptions, no roles, no relationships. The SDK works the rest out itself:

- **Descriptions and roles** are inferred by an LLM pass from the field structure alone.
- **Relationships** are discovered by SAMPLING YOUR REAL DATA, not by guessing from names. It finds
  keys whose field name matches no collection, and targets nested inside arrays your declared schema
  never mentions.
- **Field disambiguation** is inferred too — a collection carrying both `companyName` and
  `partyName` gets a note explaining which is the counterparty.

All of it is cached per schema structure, so this runs once, not once per turn. Change your models
and it re-runs automatically.

**If you're on Mongoose**, extract it by walking a live `mongoose.Schema` (`schema.eachPath(...)`) —
see [SKILL-mongodb.md](./SKILL-mongodb.md) for a worked example. **On anything else**, build the
same shape from whatever introspection your stack offers.

`role`, `description`, `relationships` and `fieldSemantics` are all OPTIONAL. Supply one and the
SDK treats it as a stated fact and will not overwrite it; omit it and the SDK fills it in. The
example below shows every field for reference — a real caller sends far less, typically just
`modelName`, `collectionName`, `fields` and `looseSchema`:

```ts
// lib/sdk-schema.ts
import type { SchemaSourceDescriptor } from "@hanexis/agentic-sdk-client";

export function getMySchemaDescriptor(): SchemaSourceDescriptor {
  return {
    connectionId: "my-app-primary",
    collections: [
      {
        modelName: "Order",
        collectionName: "orders",
        looseSchema: false,
        // OPTIONAL — omit both and the SDK infers them. Shown here only so the shape is complete.
        // `role: "application-state"` marks a collection as app-internal bookkeeping; note that
        // the real gate on what is queryable is `allowedCollections`, not this.
        role: "business-data",
        description: "A sales order placed by a customer.",
        fields: [
          { name: "_id", type: "objectId", required: true, indexed: true },
          { name: "status", type: "string", required: true, indexed: true, enumValues: ["processing", "shipped", "cancelled"] },
          { name: "grandTotal", type: "number", required: true, indexed: false },
          { name: "createdAt", type: "date", required: true, indexed: true },
        ],
        undiscoverableFields: [],
      },
      // ...every collection you want the agent to be able to query
    ],
    // OPTIONAL. Omit it: the SDK discovers relationships by sampling your real data, which is
    // stronger than anything stated here because it is confirmed against actual documents.
    // Supply one only if you have a link the data cannot show.
    relationships: [],
    // OPTIONAL, and the one place hand-written knowledge genuinely belongs: BUSINESS RULES the
    // SDK cannot derive from structure OR data, because nothing in the documents records them.
    // Keyed "Collection.field", or "Collection.parent.child" for a nested one, and reaches the
    // agent's prompt as `MEANS: ...`. Two real examples, from an actual production deployment:
    //
    //   "Order.branch": "An order with NO branch is not unassigned — it belongs to the branch
    //                    flagged isMain. Never report branch-less orders as their own bucket."
    //   "Order.fullyBilled": "Some orders lack this field entirely, and in MongoDB an absent
    //                    field does not match `false` — count with {$ne: true}, not {false}."
    //
    // Both come from observed wrong answers. Keep the list SHORT: everything here is knowledge
    // the SDK is no longer being asked to work out for itself. Do NOT use it to describe your
    // schema — that is what inference is for.
    fieldSemantics: {},
  };
}
```

You write this once per connected database, and for most callers it is a mechanical extraction with
no hand-written content at all.

## 3. Implement your query callback

This is the ONLY place your real database connection is used. Wrap it with
`createQueryCallbackHandler`, which handles auth and session-scope checking for you:

```ts
// app/api/agentic-callback/route.ts  (Next.js App Router example)
import { createQueryCallbackHandler } from "@hanexis/agentic-sdk-client";
import { MyOrderModel, MyProductModel } from "@/lib/db/models"; // however you already connect

const handler = createQueryCallbackHandler({
  callbackAuthToken: process.env.SDK_CALLBACK_TOKEN!,
  execute: async (request, allowedCollections) => {
    if (!allowedCollections.includes(request.collection)) {
      return { found: false, error: `"${request.collection}" is not in scope for this session` };
    }
    const model = request.collection === "Order" ? MyOrderModel : MyProductModel; // your own mapping
    if (!model) return { found: false, error: `Unknown collection "${request.collection}"` };

    if (request.kind === "find") {
      const docs = await model.find(request.query ?? {}).limit(request.limit ?? 50).lean();
      // `totalMatching` is the TRUE count for the filter, not just this page. Without it the agent
      // cannot tell a complete answer from the first page of one — observed live, it reported the
      // page limit it had asked for ("20 orders") as the real total, which was 34.
      const totalMatching = await model.countDocuments(request.query ?? {});
      return { found: docs.length > 0, returnedCount: docs.length, totalMatching, documents: docs };
    }
    if (request.kind === "aggregate") {
      const docs = await model.aggregate(request.query as object[]);
      return { found: docs.length > 0, returnedCount: docs.length, documents: docs };
    }
    return { found: false, error: `Unsupported query kind "${request.kind}"` };
  },
});

export async function POST(req: Request) {
  const body = await req.json();
  const { status, body: responseBody } = await handler.handle(req.headers.get("authorization"), body);
  return Response.json(responseBody, { status });
}
```

**Security note**: always independently validate `request.query`/`request.collection` yourself
(reject write operators, cap result size, etc.) — `createQueryCallbackHandler` checks auth and
session scope, but it does not know your database's query language, so it cannot validate the
query SHAPE for you. Never trust the SDK's own claim that a request is safe; that's your
database's own zero-trust boundary to enforce, the same way you would for any other untrusted
input.

## 4. Run a turn

```ts
// wherever you handle an incoming chat message
import { AgenticSdkClient } from "@hanexis/agentic-sdk-client";
import { getMySchemaDescriptor } from "@/lib/sdk-schema";

const sdk = new AgenticSdkClient({
  sdkUrl: process.env.AGENTIC_SDK_URL!, // e.g. "https://sdk.your-infra.internal"
  apiKey: process.env.AGENTIC_SDK_API_KEY!,
});

export async function askAgent(userMessage: string, history: AgentMessage[] = []) {
  const result = await sdk.runTurn({
    schema: getMySchemaDescriptor(),
    allowedCollections: ["Order", "Product"], // whatever this session may see
    queryCallbackUrl: `${process.env.APP_URL}/api/agentic-callback`,
    callbackAuthToken: process.env.SDK_CALLBACK_TOKEN!,
    scopeDescription: "the Order module", // optional, shapes the agent's own framing
    history,
    userMessage,
    onReasoningStep: (step) => console.log(`[reasoning ${step.iteration}]`, step.text),
  });
  return result.replyText; // + result.toolCalls if you want to persist/inspect what it did
}
```

That's the whole integration. No agent-loop code, no prompt engineering, no tool definitions —
those live entirely in the SDK service; you supply data shape and data access, it supplies
reasoning.

## What you're NOT expected to write

- Any prompt/reasoning logic — the SDK owns that entirely.
- A database driver inside the SDK — it never has one; your callback function IS your driver.
- Session/conversation persistence — the SDK is stateless per turn; keep your own chat history
  and pass the relevant slice as `history` on each call.

## Errors

- `AgentRefusedError` — the question was outside `outOfScopeTopics`/scope; `.module` names which
  topic. Not really an error — render it as a normal declined-answer reply.
- `AgentTurnError` — something actually went wrong (SDK unreachable, LLM overloaded, etc.);
  `.userMessage` is safe to show directly.
