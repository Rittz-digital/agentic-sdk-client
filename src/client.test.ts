import { describe, it, expect } from "vitest";
import { AgenticSdkClient, AgentTurnError, historyToAgentMessages } from "./client.js";

/**
 * Covers the two pieces of this package with real logic in them: the error mapping a user actually
 * reads, and the history conversion every integrator depends on. The rest is HTTP plumbing whose
 * shapes typecheck already guards.
 */

/** Serves one canned HTTP response, so the mapping can be exercised without a live SDK. */
function withStubbedFetch<T>(response: Response | (() => never), run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (typeof response === "function" ? response : async () => response) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const TURN = {
  schema: { connectionId: "c", collections: [] },
  allowedCollections: [],
  queryCallbackUrl: "http://callback.invalid/query",
  callbackAuthToken: "t",
  userMessage: "hi",
};

async function turnError(response: Response | (() => never)): Promise<AgentTurnError> {
  const client = new AgenticSdkClient({ sdkUrl: "http://sdk.invalid", apiKey: "k" });
  return withStubbedFetch(response, async () => {
    try {
      await client.runTurn(TURN as never);
      throw new Error("expected the turn to fail");
    } catch (err) {
      if (!(err instanceof AgentTurnError)) throw err;
      return err;
    }
  });
}

/**
 * The split that matters: these messages render straight into a chat. Observed live, a 401 showed
 * the END USER a paragraph telling them to run a key-creation command and check a specific env var
 * name — instructions they cannot act on and should never have seen.
 */
describe("error messages separate what the user sees from what operators need", () => {
  it("never leaks env var names or CLI commands to the user on a 401", async () => {
    const err = await turnError(new Response("{}", { status: 401 }));
    expect(err.userMessage).not.toMatch(/AGENTIC_SDK|npm run|\.env/);
    expect(err.userMessage).toMatch(/administrator/i);
    // The operator detail still exists — on the internal message, which is logged, not displayed.
    expect(err.message).toMatch(/apiKey/);
  });

  it("tells the user to RETRY for a transient failure, and not to for a misconfiguration", async () => {
    // Opposite fixes: waiting helps one and is actively misleading for the other.
    const busy = await turnError(new Response("{}", { status: 429 }));
    expect(busy.userMessage).toMatch(/try again/i);

    const misconfigured = await turnError(new Response("{}", { status: 401 }));
    expect(misconfigured.userMessage).not.toMatch(/try again/i);
  });

  it("maps a 5xx to a retryable user message", async () => {
    const err = await turnError(new Response("{}", { status: 503 }));
    expect(err.userMessage).toMatch(/try again/i);
    expect(err.message).toMatch(/503/);
  });

  it("does not expose the SDK's internal URL to the user when it is unreachable", async () => {
    const err = await turnError(() => {
      throw new TypeError("fetch failed");
    });
    expect(err.userMessage).not.toMatch(/http:\/\//);
    expect(err.userMessage).toMatch(/unavailable/i);
    // The URL is still in the log line, where it is the first thing an operator needs.
    expect(err.message).toMatch(/sdk\.invalid/);
  });

  it("carries the service's own error text into the internal message only", async () => {
    const err = await turnError(new Response(JSON.stringify({ error: "Invalid or revoked API key" }), { status: 401 }));
    expect(err.message).toMatch(/Invalid or revoked API key/);
    expect(err.userMessage).not.toMatch(/Invalid or revoked/);
  });
});

/**
 * Dropping tool calls from history was a real bug: a follow-up like "show me details" then arrived
 * with no record of which query produced the prior answer, so the model could re-derive a
 * different, wrong one instead of reusing the verified result.
 */
describe("historyToAgentMessages", () => {
  it("maps a plain user/assistant exchange", () => {
    const msgs = historyToAgentMessages([
      { role: "user", content: "how many orders?" },
      { role: "assistant", content: "1,463." },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "model"]);
    expect(msgs[1].parts[0]).toEqual({ kind: "text", text: "1,463." });
  });

  it("carries prior tool calls AND their results through, not just the reply text", () => {
    const msgs = historyToAgentMessages([
      {
        role: "assistant",
        content: "1,463 orders.",
        toolCalls: [{ name: "mongo_aggregate", args: { collection: "Order" }, result: { count: 1463 } }],
      },
    ]);
    const kinds = msgs.flatMap((m) => m.parts.map((p) => p.kind));
    expect(kinds).toContain("functionCall");
    expect(kinds).toContain("functionResult");
  });

  it("treats any non-user role as the model's turn", () => {
    const msgs = historyToAgentMessages([{ role: "system", content: "x" }]);
    expect(msgs[0].role).toBe("model");
  });

  it("returns nothing for an empty history rather than a placeholder turn", () => {
    expect(historyToAgentMessages([])).toEqual([]);
  });
});

describe("runTurn — session payload", () => {
  it("forwards permissions and customTools into the session sent to the SDK", async () => {
    let sentBody: any;
    const client = new AgenticSdkClient({ sdkUrl: "http://sdk.invalid", apiKey: "k" });
    await withStubbedFetch(
      async (_url: unknown, init: any) => {
        sentBody = JSON.parse(init.body);
        return new Response('{"type":"done","replyText":"ok","toolCalls":[],"schemaInferenceRan":false}\n', { status: 200 });
      },
      () =>
        client.runTurn({
          ...TURN,
          permissions: ["read", "write"],
          customTools: [{ name: "sendEmail", description: "Send an email.", parameters: { type: "object", properties: {} } }],
        } as never),
    );
    expect(sentBody.session.permissions).toEqual(["read", "write"]);
    expect(sentBody.session.customTools).toEqual([{ name: "sendEmail", description: "Send an email.", parameters: { type: "object", properties: {} } }]);
  });

  it("omits permissions/customTools from the session when not supplied", async () => {
    let sentBody: any;
    const client = new AgenticSdkClient({ sdkUrl: "http://sdk.invalid", apiKey: "k" });
    await withStubbedFetch(
      async (_url: unknown, init: any) => {
        sentBody = JSON.parse(init.body);
        return new Response('{"type":"done","replyText":"ok","toolCalls":[],"schemaInferenceRan":false}\n', { status: 200 });
      },
      () => client.runTurn(TURN as never),
    );
    expect(sentBody.session.permissions).toBeUndefined();
    expect(sentBody.session.customTools).toBeUndefined();
  });
});
