import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setRuntimeKey: vi.fn(),
  setProvider: vi.fn(),
  setBaseUrl: vi.fn(),
  setRuntimeModel: vi.fn(),
  resolveAgentKey: vi.fn(() => null as { key: string; source: string } | null),
  resolveProvider: vi.fn(() => "anthropic" as "anthropic" | "openai"),
  resolveBaseUrl: vi.fn(() => null as string | null),
  isLoginCredential: vi.fn(() => false),
}));

// The real key store touches the filesystem and the process-wide credential;
// none of that belongs in a gate test.
vi.mock("@/lib/agent/key-store", () => ({
  AGENT_MODELS: [{ id: "claude-test", label: "Claude Test" }],
  isLoginCredential: mocks.isLoginCredential,
  looksLikeAnthropicKey: (k: string) => k.startsWith("sk-ant-"),
  maskKey: (k: string) => `${k.slice(0, 6)}…`,
  resolveAgentKey: mocks.resolveAgentKey,
  resolveBaseUrl: mocks.resolveBaseUrl,
  resolveProvider: mocks.resolveProvider,
  setBaseUrl: mocks.setBaseUrl,
  setProvider: mocks.setProvider,
  setRuntimeKey: mocks.setRuntimeKey,
  setRuntimeModel: mocks.setRuntimeModel,
}));
vi.mock("@/lib/agent/client", () => ({ agentModel: () => "claude-test" }));

import { SESSION_COOKIE, SESSION_MAX_AGE, sealSession } from "@/lib/session";
import { GET, POST } from "./route";

const cookieFor = (iat = Date.now()) =>
  `${SESSION_COOKIE}=${sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat })}`;
const FORGED = `${SESSION_COOKIE}=definitely-forged`;

const get = (cookie: string) =>
  GET(new Request("http://dashboard.local/api/agent/config", { headers: { cookie } }));
const post = (cookie: string, body: unknown) =>
  POST(
    new Request("http://dashboard.local/api/agent/config", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/agent/config session gate", () => {
  it("GET 401s a forged cookie (presence alone is not a session)", async () => {
    expect((await get(FORGED)).status).toBe(401);
  });

  it("POST with a forged cookie cannot set the shared API key", async () => {
    const res = await post(FORGED, { key: "sk-ant-attacker-key" });
    expect(res.status).toBe(401);
    expect(mocks.setRuntimeKey).not.toHaveBeenCalled();
  });

  it("POST with a forged cookie cannot switch provider, base URL, or model", async () => {
    expect((await post(FORGED, { provider: "openai" })).status).toBe(401);
    expect((await post(FORGED, { baseUrl: "https://evil.example/v1" })).status).toBe(401);
    expect((await post(FORGED, { model: "claude-test" })).status).toBe(401);
    expect((await post(FORGED, { clear: true })).status).toBe(401);
    expect(mocks.setProvider).not.toHaveBeenCalled();
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.setRuntimeModel).not.toHaveBeenCalled();
    expect(mocks.setRuntimeKey).not.toHaveBeenCalled();
  });

  it("POST with an expired cookie is rejected too", async () => {
    const expired = cookieFor(Date.now() - (SESSION_MAX_AGE * 1000 + 1_000));
    expect((await post(expired, { key: "sk-ant-stale" })).status).toBe(401);
    expect(mocks.setRuntimeKey).not.toHaveBeenCalled();
  });

  it("GET serves status (never the key) to a verified session", async () => {
    const res = await get(cookieFor());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, provider: "anthropic", model: "claude-test" });
  });

  it("POST stores a key for a verified session", async () => {
    const res = await post(cookieFor(), { key: "sk-ant-legit" });
    expect(res.status).toBe(200);
    expect(mocks.setRuntimeKey).toHaveBeenCalledWith("sk-ant-legit");
  });
});
