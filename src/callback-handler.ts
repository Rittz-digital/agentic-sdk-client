import type { CustomToolDefinition, QueryRequest, QueryResult } from "./types.js";

/**
 * What YOUR application supplies to handle a query callback — the one function where your real
 * database connection actually gets used. Everything else (auth, session-scope lookup, request
 * parsing) is handled by `createQueryCallbackHandler` below, so this is the only piece an
 * integration is expected to write by hand.
 */
export type QueryExecutor = (request: QueryRequest, allowedCollections: string[]) => Promise<QueryResult>;

/**
 * What YOUR application supplies to run a custom tool call (send an email, export a file — see
 * `CustomToolDefinition`). Only needed if you pass `customTools` in `AgentSessionConfig`; omit
 * `opts.executeCustomTool` entirely if you have none. `name` is one of the names you declared.
 */
export type CustomToolExecutor = (name: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>;

/**
 * Minimal in-memory session-scope tracker — what `allowedCollections` a given `sessionId` was
 * granted, so a callback handler can independently re-check every request (never trust the SDK's
 * own claim about what it's allowed to ask for; the same zero-trust principle a real query
 * validator should already apply at execution time too).
 *
 * A production deployment with multiple app instances behind a load balancer should replace this
 * with a shared store (Redis, etc.) — the interface is intentionally this small so that swap
 * doesn't touch anything else.
 */
export interface SessionScopeStore {
  register(sessionId: string, allowedCollections: string[]): void;
  get(sessionId: string): string[] | null;
  end(sessionId: string): void;
}

export function createInMemorySessionScopeStore(ttlMs = 5 * 60_000): SessionScopeStore {
  const sessions = new Map<string, { allowedCollections: string[]; expiresAt: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, entry] of sessions) if (entry.expiresAt < now) sessions.delete(id);
  };
  return {
    register(sessionId, allowedCollections) {
      sweep();
      sessions.set(sessionId, { allowedCollections, expiresAt: Date.now() + ttlMs });
    },
    get(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.expiresAt < Date.now()) return null;
      return entry.allowedCollections;
    },
    end(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

/**
 * Builds a framework-agnostic (Request in, Response-shaped object out) handler for your query-
 * callback endpoint. Plug its output into whatever router you use — the examples below show
 * Next.js App Router and plain Express; the function itself imports neither.
 *
 * @param opts.callbackAuthToken The SAME secret you pass as `callbackAuthToken` in every
 *   `runTurn` call — this handler rejects any request whose `Authorization: Bearer <token>`
 *   doesn't match it.
 * @param opts.sessionScopeStore Defaults to an in-memory store — register a session's scope with
 *   it (via `sessionScopeStore.register(sessionId, allowedCollections)`) BEFORE calling
 *   `client.runTurn(...)` with that same session, or every callback for that turn will be refused
 *   as an unknown session. (The exported `AgenticSdkClient.runTurn` does NOT do this for you,
 *   since the scope-registration and the turn-start are two different HTTP calls in your own
 *   server that only you can sequence correctly.)
 * @param opts.execute Your real query executor — see `QueryExecutor`.
 * @param opts.executeCustomTool Your custom-tool dispatcher — see `CustomToolExecutor`. Only
 *   required if `AgentSessionConfig.customTools` is non-empty on the turns you start; a custom
 *   tool call arriving with none configured is rejected with a clear error rather than throwing.
 */
export function createQueryCallbackHandler(opts: {
  callbackAuthToken: string;
  sessionScopeStore?: SessionScopeStore;
  execute: QueryExecutor;
  executeCustomTool?: CustomToolExecutor;
}) {
  const store = opts.sessionScopeStore ?? createInMemorySessionScopeStore();

  return {
    store,
    /** Call this with the parsed request body and the raw Authorization header value. Framework-agnostic — see the module doc comment for wiring examples. */
    async handle(
      authorizationHeader: string | null,
      body: { sessionId?: string; request?: QueryRequest; customTool?: { name?: string; args?: Record<string, unknown> } },
    ): Promise<{ status: number; body: QueryResult | { result?: unknown; error?: string } }> {
      if (authorizationHeader !== `Bearer ${opts.callbackAuthToken}`) {
        return { status: 401, body: { error: "Unauthorized" } };
      }
      const sessionId = body?.sessionId;
      if (typeof sessionId !== "string") {
        return { status: 400, body: { error: "Malformed callback request" } };
      }
      const allowedCollections = store.get(sessionId);
      if (!allowedCollections) {
        return { status: 403, body: { error: "Unknown or expired session" } };
      }

      if (body.customTool) {
        const { name, args } = body.customTool;
        if (typeof name !== "string" || !args || typeof args !== "object") {
          return { status: 400, body: { error: "Malformed custom tool callback request" } };
        }
        if (!opts.executeCustomTool) {
          return { status: 500, body: { error: `Received a call for custom tool "${name}" but no executeCustomTool was configured.` } };
        }
        const result = await opts.executeCustomTool(name, args);
        return { status: 200, body: result };
      }

      const request = body?.request;
      if (!request || typeof request.collection !== "string") {
        return { status: 400, body: { error: "Malformed callback request" } };
      }
      const result = await opts.execute(request, allowedCollections);
      return { status: 200, body: result };
    },
  };
}

export type { CustomToolDefinition };
