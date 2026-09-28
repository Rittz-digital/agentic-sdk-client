---
name: agentic-sdk-client-custom-tools
description: Give the Agentic SDK's agent your own actions — send an email, post a message, export a file — via custom tools: the code-enforced confirmation flow (including cancellation), attaching real files by reference across several send tools, and rendering the model's markdown as branded output.
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
          -> the SDK ends the turn HERE — see §3.1 — replyText = the draft; toolCalls include askUser
          -> your app saves the message WITH toolCalls; UI shows the draft + picker
user clicks "Send it"
  turn 2  userMessage = "Send it\n[User picked: Send it]"; history includes turn 1's askUser
          -> agent calls sendEmail -> SDK sees the prior askUser, forwards to YOUR callback
          -> your executeCustomTool sends the mail, returns { result: { sent: true } }
          -> agent replies "Sent to a@b.com."
```

Two more real branches worth knowing before you build the picker, both covered in §3:

- The agent sometimes writes the confirmation as **plain text instead of calling `askUser`** (a
  habit no amount of prompt wording fully suppresses). The SDK detects this by the draft's own
  shape and raises the picker itself — same result, no extra code on your side.
- The user can **decline** a picker with no model call at all — your own app builds that, and it
  needs to tell the SDK, not just hide the UI. See §3.2.

## Wiring it up

A working layout (from the reference integration, which happens to be Next.js — nothing below is
Next-specific except where labeled; §c gives the Express shape for the one genuinely
framework-touching piece, the callback route). Adapt the paths, keep the split:

```
lib/ai/sdk-client/
  custom-tools.ts        # CUSTOM_TOOLS declarations + executeCustomTool dispatcher — plain TS, no framework import
  run-sdk-turn.ts        # passes customTools on every turn; exports sessionScopeStore — plain TS
lib/email/
  mailer.ts              # the real side effect (nodemailer), with its own validation — plain TS
  email-template.ts      # markdown body -> branded HTML (§6) — plain TS
<your router>/query-callback     # ONE route for queries AND custom tools — the framework-specific part, §c
<your router>/send-stream        # saves each turn WITH its toolCalls (§3) — routing is yours; the save/read calls are plain TS
components/assistant/chat-input-picker.tsx    # the one generic askUser picker — your UI framework, not ours
```

**Credentials stay in your app.** The SMTP password (`GMAIL_USER` / `GMAIL_APP_PASSWORD` here) is
read only by `mailer.ts`. The SDK never sees it; it only ever sees the tool's name and args.

### a. Declare and dispatch: `custom-tools.ts`

Two pieces: a **declaration** (name, description, JSON-schema parameters) sent on every turn, and a
**dispatcher** your callback runs.

```ts
import "server-only";   // Next.js-only guard against this file reaching client code — omit outside Next.js, there is nothing else framework-specific here
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
  // A plain env var naming YOUR app's own public URL — no framework convention attached to the
  // name; Next.js users often reuse NEXT_PUBLIC_APP_URL here since they already have one.
  queryCallbackUrl: `${process.env.APP_PUBLIC_URL}/api/agentic-sdk/query-callback`,
  callbackAuthToken: process.env.AGENTIC_SDK_CALLBACK_TOKEN ?? "",
  permissions: ["read"],        // custom tools do NOT need write — that is for your own data (§7)
  customTools: CUSTOM_TOOLS,
  history: historyToAgentMessages(windowedHistory),   // stored messages, WITH toolCalls (§3)
  // A picker answer arrives as the label plus the "[User picked: ...]" block (see d.)
  userMessage: hiddenContext ? `${userMessage}\n${hiddenContext}` : userMessage,
  signal, onReasoningStep, onTextChunk,
});
```

### c. One callback route for queries and tools: `query-callback`

The same route and the same handler as your data queries — `createQueryCallbackHandler` (built once,
[SKILL.md §4](./SKILL.md)) imports no HTTP framework at all. The handler routes a `{ customTool }`
body to `executeCustomTool` and a `{ request }` body to `execute`, so there is no second endpoint to
secure, whichever framework you host it on.

```ts
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
```

**Next.js (App Router)**, `app/api/agentic-sdk/query-callback/route.ts`:

```ts
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, body: responseBody } = await handler.handle(request.headers.get("authorization"), body ?? {});
  return Response.json(responseBody, { status });
}
```

**Express**, same `handler` object, just a different route:

```ts
app.post("/api/agentic-sdk/query-callback", express.json(), async (req, res) => {
  const { status, body: responseBody } = await handler.handle(req.headers.authorization ?? null, req.body ?? {});
  res.status(status).json(responseBody);
});
```

Nothing else in this section is framework-specific — `handler` itself, `executeQueryCallback`, and
`executeCustomTool` are plain functions your router calls into, regardless of which one you use.

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

   Give the picker a dismiss (X) button — but hiding it client-side is only HALF the job. Nothing
   has happened yet at that point (no side effect to undo), but the SDK still needs to be told the
   draft was declined, or it looks unanswered on the next turn. See §3.4 for the small endpoint that
   records the decline.

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
- **Several gated tools can share one confirmation flow.** You are not limited to one — declare
  `sendEmail`, `sendWhatsApp`, whatever else, each with `requiresPriorConfirmation: true`, and each
  is independently gated: an `askUser` answered in a prior turn confirms whichever action the model
  is now calling, by the same "was `askUser` called before this turn" rule. Nothing extra to wire
  for a second gated tool.

You do not have to get this right yourself — the SDK does the hard part, in code, in three ways:

### 3.1. Every successful `askUser` ends the turn

Whether the agent called it itself or the SDK raised it for the agent (§3.2), the turn ends the
moment a call to `askUser` succeeds — `replyText` becomes exactly what that call asked, and nothing
queued after it in the same response runs. This used to only apply to a document-length prompt (a
drafted email); a short question ("Which format — PDF or Word?") let the loop continue, and the
agent went on to *answer its own question* and act on a choice nobody made — observed live as a
finished PDF sitting next to a still-open "which format?" picker. Now any `askUser` closes the turn,
so this can never happen regardless of how long the prompt is.

A gated tool the agent already called earlier in the SAME turn (a genuine confirmed send, not a
draft) is not re-gated by a later `askUser` in that turn — a recap in the reply is not a new
request for confirmation.

### 3.2. A plain-text confirmation becomes a real picker, detected by its SHAPE

The agent sometimes drafts an action as prose — the message text plus a question like "Should I
send this?" — without actually calling `askUser`. Matching that question's *wording* is a losing
game: three different phrasings each slipped past the last one in testing ("Should I send this
now?", then "just confirm whether you'd like to proceed.", ending in a period, then "Does this look
good to send?"). So the SDK also recognizes the **shape of a draft**: several lines each labelled
with one of the gated tool's own declared parameter names (`To:`, `Subject:` for an email; whatever
your tool's schema calls them) is treated as a drafted call regardless of what question, if any,
follows it.

Either way, the SDK raises `askUser` itself — draft as `prompt`, generic "Yes, go ahead" / "Let me
change something" / "No, don't do this" options — and it lands in `result.toolCalls` exactly like a
call the agent made itself. You render it the same way either way; there is nothing in your code
that needs to know which path produced it.

### 3.3. Your side: persist history correctly

- **Persist tool calls in history.** The gate reads prior `askUser` calls from the `history` you send.
  `historyToAgentMessages` rebuilds them from each stored message's `toolCalls`, so store those, or
  every gated call is rejected as unconfirmed. This is the most likely reason a confirmed send is
  still refused.
- **Keep the history slice tight.** The gate accepts *any* earlier `askUser` in the history you pass,
  so an old chart-type picker in a long thread would also satisfy it. Pass the relevant recent slice
  (see "History is yours" in SKILL.md) rather than the whole thread forever.

### 3.4. Letting the user say no — cancelling a picker

`askUser` itself has no notion of "no answer, ever" — closing the picker without picking anything is
entirely your UI's job, and it is easy to get only half right: a dismiss button that just hides the
picker client-side leaves the SDK, on the NEXT turn, still seeing an unanswered draft in history —
the agent never learns the user declined.

Build this as a **separate endpoint your app owns**, not a `runTurn` call — there is nothing for the
model to decide, so don't spend a model call on it:

1. Check the last saved message is still an open `askUser` (the same shape step **d**'s
   `extractAskUser` reads) — a second click, or a stale tab after the thread moved on, must do nothing.
2. Save a fixed user message ("No, cancel this") and a fixed assistant reply ("Okay — cancelled.
   Nothing was sent or changed.") — no model call.
3. Hide the picker in your UI immediately, client-side, without waiting for that request.

The logic itself is plain TS, no framework involved — write it once, call it from whichever router:

```ts
// The shape to copy. Returns a plain object; your route just serializes it.
export async function cancelAskUser(threadId: string): Promise<{ cancelled: boolean }> {
  const messages = await chatMessageRepository.listByThread(threadId);
  const last = messages[messages.length - 1];
  const openQuestion = last?.toolCalls?.some(
    (c) => c.name === "askUser" && (c.result as { asked?: boolean } | null)?.asked === true,
  );
  if (!last || last.role !== "assistant" || last.isError || !openQuestion) return { cancelled: false };

  await chatMessageRepository.create({ threadId, role: "user", content: "No, cancel this" });
  await chatMessageRepository.create({ threadId, role: "assistant", content: "Okay — cancelled. Nothing was sent or changed." });
  await chatThreadRepository.touch(threadId, { lastMessageAt: new Date(), incrementMessageCount: 2 });
  return { cancelled: true };
}
```

**Next.js (App Router)**:

```ts
export async function POST(request: Request) {
  const { threadId } = cancelAskUserSchema.parse(await request.json());
  return Response.json(await cancelAskUser(threadId));
}
```

**Express**:

```ts
app.post("/api/assistant/cancel-ask-user", express.json(), async (req, res) => {
  const { threadId } = cancelAskUserSchema.parse(req.body);
  res.json(await cancelAskUser(threadId));
});
```

Now a declined draft reads plainly in the next turn's history as "the user said no", not as an
open question the agent might still act on.

## 4. Return as little as the model needs

Whatever your dispatcher returns is shown to the model, and anything the model sees, it may repeat.
Return the outcome (`{ sent: true }`), not transport internals: an SMTP `messageId` got quoted back
to a user as if it meant something. Keep ids, tokens and raw provider responses in your logs.

## 5. Real files, across tools: attach by REFERENCE, never by content

A tool that produces a real file (an export) and a tool that sends something to someone (email,
WhatsApp, whatever else) are naturally two different tools, but users ask for them together
("email me this as a PDF") often enough that it is worth a designed pattern, not an ad hoc one:

- **One tool builds the file and uploads it**, returning a `url` — call it `exportData` or
  `exportFile`, whatever fits your app. This is the ONLY place file bytes exist.
- **A sending tool's `attachments` parameter takes a `url`, never content.** The model cannot
  produce real binary bytes as a tool argument — it can only pass along a `url` an earlier call in
  the *same conversation* already returned. Your dispatcher then fetches that URL itself (or, for a
  provider that accepts a link directly — WhatsApp Cloud API does — passes the URL straight through)
  and attaches the real bytes; the model only ever handles a link.
- **Validate the URL is one you issued**, before fetching or forwarding it anywhere: check it starts
  with your own storage's public base URL. Skip this and a model-supplied "attachment" URL becomes a
  server-side-request-forgery vector — your backend would fetch (or hand a third party) whatever
  address the model was told to use, not only files you actually exported.

```ts
// The sending tool's dispatcher — the shape to copy, whatever the provider.
async function fetchAttachment(url: string): Promise<Buffer> {
  const prefix = process.env.STORAGE_PUBLIC_URL!.replace(/\/$/, "");
  if (!url.startsWith(`${prefix}/`)) throw new Error(`"${url}" is not a file this app exported.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch attachment: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
```

- **Cap size and count.** A real provider limit exists for every channel (SMTP relays commonly cap
  well under 25MB; WhatsApp Cloud API accepts exactly one attachment per message, not several) —
  enforce your own cap before fetching anything, and say so in the tool's description so the model
  offers a link instead of an attachment once a file is too large.
- **Tell the model when to attach vs. link.** A small file (a single record's PDF) → attach it for
  real. A large one (a bulk export) → put the `url` in the message body as a normal link instead —
  a link handles any size, an attachment does not. Leave this decision to the tool description, not
  to code: it is a judgement call about the specific request, not a fixed rule.
- **Show the file in your UI from `toolCalls`, not from the model's words.** The same false-claim
  risk as everywhere else in this guide: a model that says "I've attached the file" without it
  actually landing in the send call's `attachments` argument is stating something that didn't
  happen. Read the real outcome out of `result.toolCalls` instead of trusting the reply text —
  same principle as §5.5's charts/tables in SKILL.md, applied to files:

```ts
function extractAttachedFiles(toolCalls: { name: string; args: any; result: any }[]) {
  const files = new Map<string, { url: string; filename: string; sent?: boolean }>();
  for (const call of toolCalls) {
    const result = call.result?.ok === true ? call.result.result : call.result; // unwrap {ok,result} if your SDK wraps custom-tool results
    if (call.name === "exportData" && result?.url) {
      files.set(result.url, { url: result.url, filename: filenameFromUrl(result.url) });
    }
    if (call.name === "sendEmail" && result?.sent && call.args.attachments) {
      for (const a of call.args.attachments) files.set(a.url, { url: a.url, filename: a.filename, sent: true });
    }
  }
  return [...files.values()];
}
```

Render one small "download this file" element per entry, under the reply — real, clickable, and
correct whether the model mentioned the file in words or not.

## 6. The model writes structure; your code does presentation

For anything with a visual form (an email, a PDF, a message card), don't ask the model to produce
HTML or fill a template's styling. Have it write **markdown**: paragraphs, bold, and a table for
several records. Then render that markdown into your branded template in code.

- **What the user confirms is what gets sent.** The `askUser` picker and the chat reply already render
  markdown, so the table the user approves is the same table the recipient receives.
- **The model can't break your brand.** Colours, spacing and layout live in your template, where a
  model's inconsistency cannot reach them.
- **Say "one table, one row per record" in the description.** Left alone, the agent wrote a block of
  `Label: value` lines per record. Laid out as cards, that became unreadable at 20 records.
- **Apply the SAME repairs your chat renderer already has.** A model habit that slips past prompt
  wording in chat slips past it here too, for the identical reason — reuse the fix, don't
  re-discover it per surface. Two concrete ones worth building once, centrally, and running
  wherever markdown is rendered (chat, the `askUser` picker, an exported document):
  - **A table missing its separator row.** `remark-gfm` correctly refuses to parse a table with no
    `|---|---|` line under the header — the model omits it often enough that "insert one when a
    block of pipe-rows has none" earns a real repair pass before parsing, not a prompt-only fix.
  - **Raw `<br>` tags instead of markdown line breaks.** A model reaching for HTML when it wants a
    line break is common; if you (correctly) never render raw HTML from the model, `<br>` then
    shows as the literal four characters. Translate it to a real newline before parsing, rather
    than starting to trust arbitrary HTML just to fix this one case.
  - Both are "fix the known-bad shape before parsing" — the same principle as recognizing a drafted
    action by its shape rather than its wording (§3.2): cheaper and more reliable than getting every
    model call to never produce the bad shape in the first place.
- **A document about ONE thing needs a different layout than a table of MANY things** — don't reuse
  your bulk-export tool for it. A single record's details rendered through a "one row per record"
  table exporter becomes one absurdly wide row; the fix is a second tool (or a `format`/`mode`
  argument) that lays out a details list + an items table, the same shape a person would write by
  hand, and states which shape the content needs in ITS description so the model doesn't reach for
  the row-per-record tool out of habit.
- **A field literally named "Label"/"Value" in your instructions can get echoed as literal text.**
  If your tool description says "write `**Label:** value` lines", say it with a real example field
  name (`**Order Number:** ORD-1`) — a model can and will read "Label" as the field's own name and
  write out the word "Label" itself, not the actual field. Show, don't describe, whenever the
  description's own wording could be mistaken for content.

```ts
// Parse with the same remark + GFM stack your chat renderer uses, so a table that renders in the
// picker renders here too. Escape every text node; never pass raw HTML through.
const tree = unified().use(remarkParse).use(remarkGfm).parse(body);
const html = renderToBrandedEmail(tree);   // inline styles + table layout — email clients ignore <style>
sendMail({ from, to, subject, text: body, html });
```

Send the markdown as the `text` part alongside the HTML, for clients that don't render HTML.

**One more real gap, easy to miss:** if you draw PDFs with a library that ships only Latin fonts
(pdfkit's built-in Helvetica, for one), a currency symbol outside plain ASCII — ₹, €, £ in some
fonts — silently renders as a placeholder glyph. Embed a font that actually covers the symbols your
data uses (a broad Unicode sans like Noto Sans covers ₹ and most currency symbols) rather than
discovering this from a user screenshot.

## 7. Mutating your own data: `permissions`, not custom tools

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
- [ ] `requiresPriorConfirmation: true` on every irreversible tool — several gated tools can share the same confirmation flow, no extra wiring needed
- [ ] Stored messages keep their `toolCalls`, so `askUser` survives into the next turn's history
- [ ] History slice is recent and relevant, not the whole thread
- [ ] UI shows the final saved reply from `done` (not the streamed text) **and** the `askUser` picker from the last message; picks go back as label + `"[User picked: ...]"`
- [ ] A picker "cancel"/dismiss button POSTs to your own endpoint (a saved "no" + fixed reply, no model call) — not just a client-side hide, or the agent never learns the draft was declined
- [ ] A real file is attached to a send only by `url` reference to an earlier export call's own result, never model-authored content — and that `url` is checked against your own storage's base URL before you fetch or forward it anywhere
- [ ] Attachment count/size capped to the real provider limit (per channel — email and WhatsApp differ), with the tool description telling the model when to attach vs. link instead
- [ ] Your UI shows attached/exported files by reading `toolCalls`, not by trusting the model's reply text
- [ ] Results carry the outcome only, with no provider ids or internals
- [ ] Visual output: model writes markdown, your code renders the branded template; plain-text part included; the SAME `<br>`/missing-table-separator repairs your chat renderer has are applied here too
- [ ] A record's-worth-of-detail export uses a details-layout tool/mode, not the row-per-record bulk exporter
- [ ] Any font used to draw a PDF actually covers the symbols your data needs (currency symbols especially)
- [ ] Data mutation via `permissions` + your `execute` callback, re-checked there, not via a custom tool
