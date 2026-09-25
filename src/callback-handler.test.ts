import { describe, it, expect } from "vitest";
import { createQueryCallbackHandler, createInMemorySessionScopeStore } from "./callback-handler.js";

/**
 * `handle` routes ONE envelope to two different destinations — a data query to `execute`, a
 * custom tool call to `executeCustomTool` — based on which field the body carries. These tests
 * pin that routing, the auth/session checks that apply to both, and that a custom tool call
 * arriving with no `executeCustomTool` configured fails clearly instead of throwing.
 */

const TOKEN = "secret-token";

function scopedStore(sessionId: string, allowed: string[]) {
  const store = createInMemorySessionScopeStore();
  store.register(sessionId, allowed);
  return store;
}

describe("createQueryCallbackHandler — auth and session checks (shared by both request kinds)", () => {
  it("rejects a request with the wrong bearer token", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => ({ found: true }),
    });
    const res = await handler.handle("Bearer wrong", { sessionId: "s1", request: { collection: "Order", kind: "find", query: {} } });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown session id", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: createInMemorySessionScopeStore(),
      execute: async () => ({ found: true }),
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "unregistered", request: { collection: "Order", kind: "find", query: {} } });
    expect(res.status).toBe(403);
  });
});

describe("createQueryCallbackHandler — data query routing", () => {
  it("calls execute with the request and the session's allowed collections", async () => {
    let received: unknown;
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async (request, allowed) => {
        received = { request, allowed };
        return { found: true, documents: [] };
      },
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", request: { collection: "Order", kind: "find", query: { x: 1 } } });
    expect(res.status).toBe(200);
    expect((received as any).allowed).toEqual(["Order"]);
    expect((received as any).request.collection).toBe("Order");
  });

  it("rejects a malformed request (missing collection)", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => ({ found: true }),
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", request: {} as never });
    expect(res.status).toBe(400);
  });
});

describe("createQueryCallbackHandler — custom tool routing", () => {
  it("routes a customTool body to executeCustomTool, not execute", async () => {
    let executeCalled = false;
    let customCalled: { name: string; args: unknown } | null = null;
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => {
        executeCalled = true;
        return { found: true };
      },
      executeCustomTool: async (name, args) => {
        customCalled = { name, args };
        return { result: { sent: true } };
      },
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", customTool: { name: "sendEmail", args: { to: "a@b.com" } } });
    expect(res.status).toBe(200);
    expect(executeCalled).toBe(false);
    expect(customCalled).toEqual({ name: "sendEmail", args: { to: "a@b.com" } });
    expect((res.body as any).result).toEqual({ sent: true });
  });

  it("fails clearly when a custom tool call arrives but none is configured", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => ({ found: true }),
      // executeCustomTool omitted deliberately
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", customTool: { name: "sendEmail", args: {} } });
    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/sendEmail/);
  });

  it("rejects a malformed custom tool body (missing name)", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => ({ found: true }),
      executeCustomTool: async () => ({ result: null }),
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", customTool: { args: {} } as never });
    expect(res.status).toBe(400);
  });

  it("passes the custom tool's error back rather than throwing", async () => {
    const handler = createQueryCallbackHandler({
      callbackAuthToken: TOKEN,
      sessionScopeStore: scopedStore("s1", ["Order"]),
      execute: async () => ({ found: true }),
      executeCustomTool: async () => ({ error: "SMTP down" }),
    });
    const res = await handler.handle(`Bearer ${TOKEN}`, { sessionId: "s1", customTool: { name: "sendEmail", args: {} } });
    expect(res.status).toBe(200);
    expect((res.body as any).error).toBe("SMTP down");
  });
});
