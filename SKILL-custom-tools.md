---
name: agentic-sdk-client-custom-tools
description: Give the Agentic SDK's agent your own actions — send an email, post a message, export a file — via custom tools, with a code-enforced confirmation step for anything irreversible.
---

# Agentic SDK — custom tools

Read [SKILL.md](./SKILL.md) first. This guide covers letting the agent **do** something in your
application rather than only read data: send an email, post a WhatsApp message, export a report.

**The same rule as data queries applies:** the SDK never performs the action. It forwards
`{ name, args }` to your query-callback URL, your code does the work, and whatever you return goes
back to the model. The SDK holds no SMTP credentials, no API keys, nothing that acts on the world.

## The flow, end to end

```
user: "Email a@b.com the status of ORD-17 and ORD-16"
  turn 1  agent queries data -> calls askUser(prompt = full draft)
          -> SDK ends the turn; replyText = the draft; toolCalls include askUser
          -> your app saves the message WITH toolCalls; UI shows the draft + picker
user clicks "Send it"
  turn 2  userMessage = "Send it\n[User picked: Send it]"; history includes turn 1's askUser
          -> agent calls sendEmail -> SDK sees the prior askUser, forwards to YOUR callback
          -> your executeCustomTool sends the mail, returns { result: { sent: true } }
          -> agent replies "Sent to a@b.com."
```

## Wiring it up

A working layout (from the reference integration). Adapt the paths, keep the split:

```
lib/ai/sdk-client/
  custom-tools.ts        # CUSTOM_TOOLS declarations + executeCustomTool dispatcher
  run-sdk-turn.ts        # passes customTools on every turn; exports sessionScopeStore
lib/email/
  mailer.ts              # the real side effect (nodemailer), with its own validation
  email-template.ts      # markdown body -> branded HTML (§5)
app/api/agentic-sdk/query-callback/route.ts   # ONE route for queries AND custom tools
app/api/assistant/send-stream/route.ts        # saves each turn WITH its toolCalls (§3)
components/assistant/chat-input-picker.tsx    # the one generic askUser picker
```

**Credentials stay in your app.** The SMTP password (`GMAIL_USER` / `GMAIL_APP_PASSWORD` here) is
read only by `mailer.ts`. The SDK never sees it; it only ever sees the tool's name and args.

### a. Declare and dispatch: `custom-tools.ts`

Two pieces: a **declaration** (name, description, JSON-schema parameters) sent on every turn, and a
**dispatcher** your callback runs.

```ts
import "server-only";
import type { CustomToolDefinition } from "@hanexis/agentic-sdk-client";
import { sendEmail } from "@/lib/email/mailer";

export const CUSTOM_TOOLS: CustomToolDefinition[] = [
  {
    name: "sendEmail",
    description: "...",   // §2: this is most of the work
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body in markdown. No HTML." },
      },
      required: ["to", "subject", "body"],
    },
    requiresPriorConfirmation: true,   // §3
  },
];

export async function executeCustomTool(name: string, args: Record<string, unknown>) {
  if (name === "sendEmail") {
    const result = await sendEmail({ to: String(args.to ?? ""), subject: String(args.subject ?? ""), body: String(args.body ?? "") });
    if (!result.sent) return { error: result.error };
    return { result: { sent: true } };   // §4: nothing the model could quote back
  }
  return { error: `Unknown custom tool: "${name}"` };
}
```

The SDK makes no assumptions about tool names: `sendEmail` is just a name you picked. Adding
another tool (WhatsApp, an export) means one more entry in `CUSTOM_TOOLS` and one more branch in
`executeCustomTool`, nothing else.

### b. Send them on every turn: `run-sdk-turn.ts`

```ts
export const sessionScopeStore = createInMemorySessionScopeStore();   // the route imports THIS instance
export const sdkClient = new AgenticSdkClient({ sdkUrl, apiKey, sessionScopeStore });

const result = await sdkClient.runTurn({
  schema,
  allowedCollections,
  queryCallbackUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/agentic-sdk/query-callback`,
  callbackAuthToken: process.env.AGENTIC_SDK_CALLBACK_TOKEN ?? "",
  permissions: ["read"],        // custom tools do NOT need write — that is for your own data (§6)
  customTools: CUSTOM_TOOLS,
  history: historyToAgentMessages(windowedHistory),   // stored messages, WITH toolCalls (§3)
  // A picker answer arrives as the label plus the "[User picked: ...]" block (see d.)
  userMessage: hiddenContext ? `${userMessage}\n${hiddenContext}` : userMessage,
  signal, onReasoningStep, onTextChunk,
});
```

### c. One callback route for queries and tools: `query-callback/route.ts`

The same route and the same handler as your data queries. The handler routes a `{ customTool }` body
to `executeCustomTool` and a `{ request }` body to `execute`, so there is no second endpoint to
secure.

```ts
import { type NextRequest } from "next/server";
import { createQueryCallbackHandler } from "@hanexis/agentic-sdk-client";
import { executeQueryCallback } from "@/lib/ai/sdk-client/execute-query";
import { executeCustomTool } from "@/lib/ai/sdk-client/custom-tools";
import { sessionScopeStore } from "@/lib/ai/sdk-client/run-sdk-turn";   // SAME instance as the client

const handler = createQueryCallbackHandler({
  callbackAuthToken: process.env.AGENTIC_SDK_CALLBACK_TOKEN ?? "",
  sessionScopeStore,
  execute: executeQueryCallback,
  executeCustomTool,              // omit only if you declare no custom tools
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const { status, body: responseBody } = await handler.handle(request.headers.get("authorization"), body ?? {});
  return Response.json(responseBody, { status });
}
```

A call arriving for a custom tool when no `executeCustomTool` is configured fails with a clear 500,
not a silent drop. The bearer token and session-scope checks apply to tool calls exactly as they do
to queries.

### d. Save the turn and render it: send route + UI

**Server (the route that runs the turn):** save the assistant message *with* `toolCalls`, and build
next turn's history from stored messages, minus failed turns, last N only:

```ts
const allHistory = await chatMessageRepository.listByThread(threadId);
const windowedHistory = allHistory.filter((m) => !m.isError).slice(-MAX_CHAT_HISTORY_MESSAGES);
// ...run the turn...
const assistantMsg = await chatMessageRepository.create({
  threadId, role: "assistant",
  content: result.replyText,
  toolCalls: result.toolCalls,   // the confirmation gate reads askUser from here next turn
});
send({ type: "done", assistantMessage: assistantMsg });
```

**Client:** three rules.

1. **Show the final message from `done`, not the streamed text.** On a confirmation turn the SDK
   replaces the reply with the draft after streaming, so the saved `replyText` is the truth.
2. **Picker from the last message only**, and only while nothing is being sent:

   ```ts
   const pendingAskUser =
     last?.role === "assistant" && !last.isError && !isSending && last.id !== dismissedId
       ? extractAskUser(last.toolCalls)       // the askUser call's result.awaitingInput
       : null;
   ```

3. **A pick sends the label as the visible message and the pick block as hidden context:**

   ```ts
   onChooseOption={(option) => send(option.label, formatAskUserPick(option))}
   // formatAskUserPick -> "[User picked: Send it]" (+ "\n" + JSON.stringify(value) if the option has one)
   onFreeText={(text) => send(text)}          // an edit ("change the subject") is just a normal message
   ```

   Give the picker a dismiss (X) button that only hides it client-side. Nothing has happened yet at
   that point, so nothing needs sending to cancel.

`extractAskUser` and `formatAskUserPick` are two small helpers you write yourself; this package
does not export them. The reference app's versions:

```ts
export function extractAskUser(toolCalls: { name: string; result: unknown }[]) {
  for (const call of toolCalls) {
    if (call.name !== "askUser") continue;
    const a = (call.result as { awaitingInput?: any } | null)?.awaitingInput;
    if (typeof a?.prompt !== "string" || !Array.isArray(a.options)) continue;
    const options = a.options.filter((o: any) => typeof o?.id === "string" && typeof o?.label === "string");
    if (options.length === 0) continue;
    return { prompt: a.prompt, options, allowFreeText: a.allowFreeText !== false, freeTextPlaceholder: a.freeTextPlaceholder };
  }
  return null;
}

export function formatAskUserPick(option: { label: string; value?: unknown }): string {
  const base = `[User picked: ${option.label}]`;
  return option.value === undefined ? base : `${base}\n${JSON.stringify(option.value)}`;
}
```

## 1. Validate in your dispatcher

The SDK does **not** validate `args` against your `parameters` schema. The schema tells the model
what to send; your dispatcher is an externally reachable endpoint and must check what actually
arrives: address shape, empty fields, lengths. Return failures as `{ error }`, never throw. The
model can read an error and correct itself; a 500 just ends its turn.

## 2. The description is the model's only instructions

Everything the agent knows about a tool comes from its `description`. **Domain rules belong here**,
in your app, not in the SDK. The SDK is shared across businesses and stays tool-agnostic. Write
the rules the way `fieldSemantics` rules are written: from real failures, each with its
consequence. For an outbound message, these each came from something that actually went wrong:

- **Only act when the user explicitly asks**, never on the agent's own initiative.
- **Resolve the recipient before drafting.** If the user named a customer but not an address, look it
  up (e.g. a `partyEmail` field) rather than guess one.
- **Don't assume the recipient is the customer.** An address the user supplied says nothing about who
  owns it. An email bundling *several* customers' orders is necessarily an internal report, so it
  gets no "Dear <Customer>" and no "your order" phrasing.
- **State only confirmed facts.** No invented apology narratives, SLAs ("within 48 hours") or
  compensation offers. In a real message to a real customer, those read as commitments.
- **Check the result before claiming success**, and confirm briefly ("Sent to a@b.com") without quoting
  any id from the result.

## 3. Confirmation for anything irreversible: `requiresPriorConfirmation`

Set `requiresPriorConfirmation: true` on any tool whose effect is real and hard to undo. Prompt
wording alone did not hold this. Observed live, in order: the agent sent immediately with no
confirmation; then it called `askUser` and the tool in the **same** turn; then its own looping
reasoning sent the same email twice in one turn. The gate is therefore enforced in code:

- The tool call is **rejected** unless an `askUser` call appears in a **prior, completed turn** of the
  `history` you pass. An `askUser` in the current turn doesn't count, so there is always a real
  round trip through the user.
- A gated tool fires **at most once per turn**.

What the SDK now does for you in the confirmation turn. You don't build any of this; just render
what comes back:

- **The draft is the reply.** When the agent calls `askUser` with a document-length prompt (the full
  drafted email), the turn ends right there and `replyText` *is* that draft, verbatim. Before this,
  the agent's own prose beside the picker was unreliable: sometimes the draft, sometimes a summary,
  once a false "Sent to a@b.com" above a picker still asking whether to send.
- **A plain-text "Should I send this?" becomes a real picker.** If the agent writes the draft and a
  confirmation question as prose instead of calling `askUser`, the SDK raises the `askUser` call
  itself: the draft becomes its prompt, with "Yes, go ahead" / "Let me change something" options. It
  lands in `result.toolCalls` like any other `askUser` call.

Your side is the wiring in step **d** under "Wiring it up" above: the saved reply
is the draft, so it stays readable in the chat history after the picker is gone.

**Two things your side must get right:**

- **Persist tool calls in history.** The gate reads prior `askUser` calls from the `history` you send.
  `historyToAgentMessages` rebuilds them from each stored message's `toolCalls`, so store those, or
  every gated call is rejected as unconfirmed. This is the most likely reason a confirmed send is
  still refused.
- **Keep the history slice tight.** The gate accepts *any* earlier `askUser` in the history you pass,
  so an old chart-type picker in a long thread would also satisfy it. Pass the relevant recent slice
  (see "History is yours" in SKILL.md) rather than the whole thread forever.

## 4. Return as little as the model needs

Whatever your dispatcher returns is shown to the model, and anything the model sees, it may repeat.
Return the outcome (`{ sent: true }`), not transport internals: an SMTP `messageId` got quoted back
to a user as if it meant something. Keep ids, tokens and raw provider responses in your logs.

## 5. The model writes structure; your code does presentation

For anything with a visual form (an email, a PDF, a message card), don't ask the model to produce
HTML or fill a template's styling. Have it write **markdown**: paragraphs, bold, and a table for
several records. Then render that markdown into your branded template in code.

- **What the user confirms is what gets sent.** The `askUser` picker and the chat reply already render
  markdown, so the table the user approves is the same table the recipient receives.
- **The model can't break your brand.** Colours, spacing and layout live in your template, where a
  model's inconsistency cannot reach them.
- **Say "one table, one row per record" in the description.** Left alone, the agent wrote a block of
  `Label: value` lines per record. Laid out as cards, that became unreadable at 20 records.

```ts
// Parse with the same remark + GFM stack your chat renderer uses, so a table that renders in the
// picker renders here too. Escape every text node; never pass raw HTML through.
const tree = unified().use(remarkParse).use(remarkGfm).parse(body);
const html = renderToBrandedEmail(tree);   // inline styles + table layout — email clients ignore <style>
sendMail({ from, to, subject, text: body, html });
```

Send the markdown as the `text` part alongside the HTML, for clients that don't render HTML.

## 6. Mutating your own data: `permissions`, not custom tools

Updating or deleting records in your database isn't a custom tool. It goes through `permissions`:
grant `"write"` and/or `"delete"` and the agent is offered a `performAction` tool, which arrives at
your **existing** `execute` callback as a `QueryRequest` with `kind: "update"` or `"delete"`.
Sessions default to `["read"]`. Your callback must re-check the permission and the collection scope
itself before applying anything; that boundary is yours, exactly like read-only enforcement is. Grant
it only once your callback has real, tested handling for those kinds.

## Checklist (custom tools)

Run alongside the checklist in [SKILL.md](./SKILL.md).

- [ ] Each tool declared in `customTools` **and** dispatched by name in `executeCustomTool`, passed to the same `createQueryCallbackHandler` (one route, same `sessionScopeStore` instance)
- [ ] Tool credentials (SMTP, API keys) read only by your app's side-effect code, never sent to the SDK
- [ ] Dispatcher validates its own `args` and returns `{ error }` instead of throwing
- [ ] Domain rules live in the tool's `description`, each from a real failure, with its consequence
- [ ] `requiresPriorConfirmation: true` on every irreversible tool
- [ ] Stored messages keep their `toolCalls`, so `askUser` survives into the next turn's history
- [ ] History slice is recent and relevant, not the whole thread
- [ ] UI shows the final saved reply from `done` (not the streamed text) **and** the `askUser` picker from the last message; picks go back as label + `"[User picked: ...]"`
- [ ] Results carry the outcome only, with no provider ids or internals
- [ ] Visual output: model writes markdown, your code renders the branded template; plain-text part included
- [ ] Data mutation via `permissions` + your `execute` callback, re-checked there, not via a custom tool
