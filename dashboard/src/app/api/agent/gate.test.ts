/**
 * Every agent route must open and verify the sealed session cookie itself —
 * the proxy only checks that a cookie named switchyard_session EXISTS. A forged
 * value must get a 401 before any side effect (OAuth start, token exchange,
 * spending the shared key on a chat turn, applying staged changes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startLogin: vi.fn(() => ({ url: "https://claude.ai/oauth/authorize?x=1" })),
  completeLogin: vi.fn(async () => ({ access: "a", refresh: "r", expiresAt: 1 })),
  setOAuthCredential: vi.fn(),
  runAgentTurn: vi.fn(
    async (_messages: unknown, _key: string, emit: (e: { type: string; text?: string }) => void) => {
      emit({ type: "text", text: "hi" });
    },
  ),
  applyStaged: vi.fn(),
  getOpenAI: vi.fn(),
  sessionKey: vi.fn(() => "k"),
}));

vi.mock("@/lib/agent/oauth", () => ({
  startLogin: mocks.startLogin,
  completeLogin: mocks.completeLogin,
}));
vi.mock("@/lib/agent/key-store", () => ({
  AGENT_MODELS: [{ id: "claude-test", label: "Claude Test" }],
  resolveAgentKey: () => null,
  resolveProvider: () => "anthropic",
  setOAuthCredential: mocks.setOAuthCredential,
}));
vi.mock("@/lib/agent/client", () => ({
  getOpenAI: mocks.getOpenAI,
  isAgentConfigured: () => true,
  agentModel: () => "claude-test",
}));
vi.mock("@/lib/agent/run", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("@/lib/agent/ops", () => ({ applyStaged: mocks.applyStaged }));
vi.mock("@/lib/agent/store", () => ({
  sessionKey: mocks.sessionKey,
  listStaged: () => [],
  removeStaged: () => [],
}));
vi.mock("@/lib/sse", () => ({ SSE_HEADERS: { "content-type": "text/event-stream" } }));

import { SESSION_COOKIE, sealSession } from "@/lib/session";
import * as changes from "./changes/route";
import * as chat from "./chat/route";
import * as models from "./models/route";
import * as oauthComplete from "./oauth/complete/route";
import * as oauthStart from "./oauth/start/route";

const valid = () =>
  `${SESSION_COOKIE}=${sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat: Date.now() })}`;
const FORGED = `${SESSION_COOKIE}=forged`;

type Handler = (req: Request) => Promise<Response>;
const call = (handler: Handler, cookie: string, method: "GET" | "POST", body?: unknown) =>
  handler(
    new Request("http://dashboard.local/api/agent/x", {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );

const routes: { name: string; handler: Handler; method: "GET" | "POST"; body?: unknown }[] = [
  { name: "GET /api/agent/models", handler: models.GET, method: "GET" },
  { name: "POST /api/agent/oauth/start", handler: oauthStart.POST, method: "POST" },
  { name: "POST /api/agent/oauth/complete", handler: oauthComplete.POST, method: "POST", body: { code: "abc" } },
  {
    name: "POST /api/agent/chat",
    handler: chat.POST,
    method: "POST",
    body: { messages: [{ role: "user", content: "hello" }] },
  },
  { name: "GET /api/agent/changes", handler: changes.GET, method: "GET" },
  { name: "POST /api/agent/changes", handler: changes.POST, method: "POST", body: { action: "apply" } },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent routes reject a forged session cookie", () => {
  for (const r of routes) {
    it(`${r.name} -> 401, no side effects`, async () => {
      const res = await call(r.handler, FORGED, r.method, r.body);
      expect(res.status).toBe(401);
      expect(mocks.startLogin).not.toHaveBeenCalled();
      expect(mocks.completeLogin).not.toHaveBeenCalled();
      expect(mocks.setOAuthCredential).not.toHaveBeenCalled();
      expect(mocks.runAgentTurn).not.toHaveBeenCalled();
      expect(mocks.applyStaged).not.toHaveBeenCalled();
    });
  }
});

describe("agent routes still serve a verified session", () => {
  it("GET /api/agent/models lists the catalog", async () => {
    const res = await call(models.GET, valid(), "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "anthropic", models: [{ id: "claude-test" }] });
  });

  it("POST /api/agent/oauth/start returns the authorize URL", async () => {
    const res = await call(oauthStart.POST, valid(), "POST");
    expect(res.status).toBe(200);
    expect(mocks.startLogin).toHaveBeenCalledTimes(1);
  });

  it("POST /api/agent/oauth/complete exchanges the code", async () => {
    const res = await call(oauthComplete.POST, valid(), "POST", { code: "abc" });
    expect(res.status).toBe(200);
    expect(mocks.completeLogin).toHaveBeenCalledWith("abc");
    expect(mocks.setOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it("POST /api/agent/chat streams a turn", async () => {
    const res = await call(chat.POST, valid(), "POST", { messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"done"');
    expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("GET /api/agent/changes lists the queue", async () => {
    const res = await call(changes.GET, valid(), "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, changes: [] });
  });
});

describe("agent routes partition the staged queue by the VERIFIED session", () => {
  const verified = expect.objectContaining({ dokployCookie: "sess=u1", email: "u1@example.com" });

  it("POST /api/agent/chat passes the opened session to sessionKey", async () => {
    await call(chat.POST, valid(), "POST", { messages: [{ role: "user", content: "hello" }] });
    expect(mocks.sessionKey).toHaveBeenCalledWith(verified);
    expect(mocks.runAgentTurn).toHaveBeenCalledWith(expect.anything(), "k", expect.any(Function));
  });

  it("GET + POST /api/agent/changes pass the opened session to sessionKey", async () => {
    await call(changes.GET, valid(), "GET");
    await call(changes.POST, valid(), "POST", { action: "discard" });
    expect(mocks.sessionKey).toHaveBeenCalledTimes(2);
    for (const c of mocks.sessionKey.mock.calls) expect(c[0]).toEqual(verified);
  });

  it("a forged cookie never reaches sessionKey", async () => {
    await call(changes.GET, FORGED, "GET");
    await call(chat.POST, FORGED, "POST", { messages: [{ role: "user", content: "hello" }] });
    expect(mocks.sessionKey).not.toHaveBeenCalled();
  });
});
