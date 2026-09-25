import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentMessagePart, AgentSessionConfig, CustomToolDefinition, SchemaSourceDescriptor, TopicScopeRule, TurnStreamEvent } from "./types.js";
import type { SessionScopeStore } from "./callback-handler.js";

/**
 * The thin wrapper an integrating application actually uses — everything the Next.js app hand-
 * wrote in lib/ai/sdk-client/run-sdk-turn.ts (the fetch call, NDJSON parsing, session-id
 * generation, event dispatch), packaged once so a new integration doesn't reconstruct it.
 *
 * What this does NOT do, on purpose, matching the whole architecture's one hard rule: it never
 * touches a database. `AgenticSdkClient` only knows how to talk to the SDK's HTTP surface; your
 * own query-callback handler (see `createQueryCallbackHandler` in this package) is where your
 * application's real data access lives.
 */

export type RunTurnOptions = {
  /** Schema for the connected database — already extracted/structured on YOUR side (you hold the real DB connection). */
  schema: SchemaSourceDescriptor;
  /** Which of `schema.collections` this turn's agent may see/query. */
  allowedCollections: string[];
  /** Your own endpoint the SDK calls back to for query execution — see `createQueryCallbackHandler`. */
  queryCallbackUrl: string;
  /** Shared secret the SDK echoes back on every callback so your handler can verify the request's origin. */
  callbackAuthToken: string;
  /** Optional topic-level firewall — refuse a question about some domain even though the collections are technically reachable. */
  outOfScopeTopics?: TopicScopeRule[];
  /** One-line description of what this session is scoped to, e.g. "the Order module". Shown in the model's own system prompt and in a refusal's redirect. */
  scopeDescription?: string;
  /**
   * How monetary values in your data should be written, e.g. "₹". Supply this whenever your schema
   * has money fields: the numbers themselves carry no currency, so without it the model guesses —
   * and guesses inconsistently within a single conversation.
   */
  currencySymbol?: string;
  /**
   * What this session's agent may DO to your data, not just see. Defaults to `["read"]` when
   * omitted — a read-only agent unless you explicitly grant more. See `AgentSessionConfig` in
   * types.ts for the full contract, including why your own callback must still re-check this.
   */
  permissions?: ("read" | "write" | "delete")[];
  /** Caller-defined tools with no data-query shape — send an email, export a file. See `CustomToolDefinition` in types.ts. */
  customTools?: CustomToolDefinition[];
  /** Prior turns in this conversation, oldest first. Omit or pass [] for a fresh conversation. */
  history?: AgentMessage[];
  userMessage: string;
  signal?: AbortSignal;
  /** Called once per iteration as the agent's own deliberation text arrives — wire this to a live "thinking" UI. */
  onReasoningStep?: (step: { iteration: number; text: string }) => void;
  /** Called per-delta as the FINAL answer's own text streams in — wire this to render a real typing effect instead of the whole reply appearing at once. */
  onTextChunk?: (chunk: string) => void;
};

export type RunTurnResult = {
  replyText: string;
  toolCalls: { name: string; args: unknown; result: unknown }[];
  /** True the first time this connection's raw schema needed LLM-inferred role/description/relationships — see the SDK's `GET /schema/:connectionId` to review what it inferred. */
  schemaInferenceRan: boolean;
};

export class AgentRefusedError extends Error {
  readonly module: string;
  constructor(module: string) {
    super(`question is outside the current scope: ${module}`);
    this.module = module;
  }
}

export class AgentTurnError extends Error {
  readonly userMessage: string;
  /** Whatever the failed turn managed to run before failing — empty for a failure before any tool call. */
  readonly toolCalls: { name: string; args: unknown; result: unknown }[];
  constructor(userMessage: string, internalDetail?: string, toolCalls: { name: string; args: unknown; result: unknown }[] = []) {
    super(internalDetail ?? userMessage);
    this.userMessage = userMessage;
    this.toolCalls = toolCalls;
  }
}

/**
 * What an END USER sees when a request fails. Short, plain, and free of anything only an operator
 * could act on.
 *
 * These messages render directly in the chat, so they must never contain env var names, CLI
 * commands, or file paths: observed live, a 401 surfaced a paragraph telling the user to run a
 * key-creation command and check a specific env var name — instructions they cannot follow and
 * should never have been shown. Diagnosis belongs in the INTERNAL message (see
 * `operatorDetailForStatus`), which is logged but never displayed.
 *
 * Still distinguishes a configuration problem from a transient one, because the two have opposite
 * fixes: "try again" is right for overload, and actively wrong for a bad key, where nothing will
 * change until someone fixes it.
 */
function userMessageForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "The assistant isn't configured correctly. Please contact your administrator.";
  }
  if (status === 429) {
    return "The assistant is busy right now. Please try again in a moment.";
  }
  if (status >= 500) {
    return "The assistant ran into a problem. Please try again in a moment.";
  }
  return "The assistant couldn't handle that request. Please try again.";
}

/**
 * The operator-facing half: exactly the detail removed from the message above, carried on the
 * error's own `message` so it reaches server logs without ever reaching a user's screen.
 */
function operatorDetailForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return (
      "SDK rejected the API key. Check the key you're passing as `apiKey` matches one the SDK " +
      "still holds — see your SDK deployment's own key-management tooling to issue or verify one. " +
      "Keys are typically stored hashed, so a cleared or rotated key store means a new key must be " +
      "issued and configured here."
    );
  }
  if (status === 404) {
    return "SDK returned 404 for /turns — check the `sdkUrl` you passed points at a running SDK service.";
  }
  if (status === 429) return "SDK returned 429 (at capacity).";
  if (status >= 500) return `SDK returned ${status} (internal error).`;
  return `SDK rejected the request with HTTP ${status}.`;
}

/** Appends the service's own error text to the INTERNAL detail — never to what the user sees. */
async function describeErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.text();
    if (!body) return "";
    // The SDK's own error shape is `{ error: string }`; fall back to raw text for anything else
    // (a proxy's HTML error page, say) rather than losing the detail to a parse failure.
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") return ` — ${parsed.error}`;
    } catch {
      /* not JSON — use the raw text below */
    }
    return ` — ${body.slice(0, 200)}`;
  } catch {
    return "";
  }
}

/**
 * Reshapes a plain chat history — the shape almost any chat-message table row already has —
 * into the `AgentMessage[]` `runTurn`'s `history` option expects. Every integrator needs this
 * exact conversion (it was hand-written in the Next.js app's own `run-sdk-turn.ts` before this
 * package existed); packaged here so a new integration doesn't reconstruct it. Any role that
 * isn't `"user"` is treated as the model's own turn.
 *
 * CARRIES PRIOR TOOL CALLS/RESULTS THROUGH, not just each turn's final reply text. Dropping them
 * (an earlier version of this function did exactly that) means a follow-up like "yes, show me
 * details" arrives with no record of what query actually produced the prior answer — the model
 * has only its own past prose to go on and can re-derive a DIFFERENT, wrong answer instead of
 * reusing the verified one. Passing the real `functionCall`/`functionResult` parts back is what
 * lets the model treat its own prior tool results as ground truth on the next turn, the same way
 * they read within a single turn's own iteration loop.
 */
export function historyToAgentMessages(
  history: { role: string; content: string; toolCalls?: { name: string; args: unknown; result: unknown }[] }[],
): AgentMessage[] {
  return history.flatMap((m): AgentMessage[] => {
    if (m.role === "user") {
      return [{ role: "user", parts: [{ kind: "text", text: m.content }] }];
    }
    const toolCalls = m.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return [{ role: "model", parts: [{ kind: "text", text: m.content }] }];
    }
    const callParts: AgentMessagePart[] = toolCalls.map((tc, i) => ({
      kind: "functionCall",
      id: `history-${i}`,
      name: tc.name,
      args: (tc.args ?? {}) as Record<string, unknown>,
    }));
    const resultParts: AgentMessagePart[] = toolCalls.map((tc, i) => ({
      kind: "functionResult",
      callId: `history-${i}`,
      name: tc.name,
      result: tc.result,
    }));
    return [
      { role: "model", parts: [...(m.content ? [{ kind: "text" as const, text: m.content }] : []), ...callParts] },
      { role: "user", parts: resultParts },
    ];
  });
}

export class AgenticSdkClient {
  /**
   * @param opts.sessionScopeStore If your query-callback handler was built with
   *   `createQueryCallbackHandler` (the common case), pass ITS `sessionScopeStore` here too —
   *   the SAME store instance both sides read/write. `runTurn` generates the session id
   *   internally and has no other way to hand it to your callback handler in time; registering
   *   the scope here, before the HTTP request fires, is what makes the ordering the whole
   *   architecture depends on actually correct. Omit only if you are not using
   *   `createQueryCallbackHandler` and are managing session scope some other way yourself.
   */
  constructor(private readonly opts: { sdkUrl: string; apiKey: string; sessionScopeStore?: SessionScopeStore }) {}

  /** Starts one turn and streams it to completion. */
  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    const sessionId = randomUUID();
    const session: AgentSessionConfig = {
      schema: options.schema,
      allowedCollections: options.allowedCollections,
      queryCallbackUrl: options.queryCallbackUrl,
      callbackAuthToken: options.callbackAuthToken,
      outOfScopeTopics: options.outOfScopeTopics,
      scopeDescription: options.scopeDescription,
      currencySymbol: options.currencySymbol,
      permissions: options.permissions,
      customTools: options.customTools,
    };

    // Registered BEFORE the request fires — a query callback that raced ahead of this line
    // would find no scope and get correctly refused; the reverse ordering is the actual bug
    // this prevents. See the constructor's doc comment for why this store must be the SAME
    // instance your query-callback handler reads from.
    this.opts.sessionScopeStore?.register(sessionId, options.allowedCollections);

    try {
      let res: Response;
      try {
        res = await fetch(`${this.opts.sdkUrl}/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ sessionId, session, history: options.history ?? [], userMessage: options.userMessage }),
          signal: options.signal,
        });
      } catch (err) {
        // A caller-initiated abort is not a failure to report as one — let it propagate as itself
        // so an aborted turn doesn't surface to the user as "the service is down".
        if (err instanceof Error && err.name === "AbortError") throw err;
        // THE one case that genuinely means unreachable: the connection never completed. Keeping
        // this message exclusive to this branch is the point — see `userMessageForStatus`.
        throw new AgentTurnError(
          "The assistant is unavailable right now. Please try again in a moment.",
          `Could not reach the SDK at ${this.opts.sdkUrl} — check the service is running and AGENTIC_SDK_URL is correct. ` +
            `Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok || !res.body) {
        throw new AgentTurnError(
          userMessageForStatus(res.status),
          `HTTP ${res.status}${await describeErrorBody(res)} — ${operatorDetailForStatus(res.status)}`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let final: RunTurnResult | null = null;
      let refusedModule: string | null = null;
      let errorMessage: string | null = null;
      let errorToolCalls: { name: string; args: unknown; result: unknown }[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: TurnStreamEvent;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "reasoning") options.onReasoningStep?.({ iteration: event.iteration, text: event.text });
          else if (event.type === "text") options.onTextChunk?.(event.chunk);
          else if (event.type === "done") final = { replyText: event.replyText, toolCalls: event.toolCalls, schemaInferenceRan: event.schemaInferenceRan };
          else if (event.type === "refused") refusedModule = event.module;
          else if (event.type === "error") {
            errorMessage = event.message;
            errorToolCalls = event.toolCalls ?? [];
          }
        }
      }

      if (refusedModule !== null) throw new AgentRefusedError(refusedModule);
      if (errorMessage !== null) throw new AgentTurnError(errorMessage, undefined, errorToolCalls);
      if (!final) throw new AgentTurnError("The Agentic AI SDK service ended without a response. Please try again.");
      return final;
    } finally {
      this.opts.sessionScopeStore?.end(sessionId);
    }
  }
}
