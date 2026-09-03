/**
 * Login/logout Server Actions against a stubbed Dokploy (global fetch) and
 * stubbed request cookies/headers.
 *
 *  - Logout must invalidate the Dokploy session server-side (better-auth
 *    sign-out with the session's own cookie), so a sealed cookie held elsewhere
 *    dies with it — and must still clear the local cookie when Dokploy is down.
 *  - The session cookie is Secure behind an HTTPS proxy (X-Forwarded-Proto) or
 *    with the SWITCHYARD_ASSUME_HTTPS opt-in, and plain otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  token: undefined as string | undefined,
  forwardedProto: null as string | null,
  set: vi.fn(),
  del: vi.fn(),
  redirect: vi.fn((url: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "switchyard_session" && ctx.token ? { name, value: ctx.token } : undefined,
    set: ctx.set,
    delete: ctx.del,
  }),
  headers: async () => ({
    get: (name: string) => (name.toLowerCase() === "x-forwarded-proto" ? ctx.forwardedProto : null),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: ctx.redirect }));
// dokploy.ts pulls in the Docker client; no socket in tests.
vi.mock("@/lib/docker", () => ({
  listRuntimeStates: async () => {
    throw new Error("no docker in tests");
  },
  deriveComposeRuntime: () => ({ health: "not-running" }),
  deriveSwarmRuntime: () => ({ health: "not-running" }),
}));

// Read by dokploy.ts at import time: two auth-origin candidates so the
// INVALID_ORIGIN walk has somewhere to go.
process.env.DOKPLOY_URL = "http://dokploy.test";
process.env.DOKPLOY_ORIGIN = "http://localhost:3000";

const { loginAction, logoutAction } = await import("./actions");
const { SESSION_COOKIE, sealSession } = await import("@/lib/session");

interface Call {
  path: string;
  method: string;
  cookie: string | null;
  origin: string | null;
}
const calls: Call[] = [];
/** Per-test behaviour of POST /api/auth/sign-out. */
let signOut: (call: Call) => Response | Promise<Response> = () => new Response("{}", { status: 200 });

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      path: url.pathname,
      method: init?.method ?? "GET",
      cookie: headers.get("cookie"),
      origin: headers.get("origin"),
    };
    calls.push(call);
    if (call.path === "/api/auth/sign-in/email") {
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "better-auth.session_token=fresh; Path=/; HttpOnly" },
      });
    }
    if (call.path === "/api/auth/sign-out") return signOut(call);
    return new Response("{}", { status: 404 });
  }),
);

const sealed = () => sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat: Date.now() });

/** Run an action that ends in redirect(); return the redirect target. */
async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    const m = digest.match(/^NEXT_REDIRECT;replace;([^;]+);/);
    if (m) return m[1];
    throw e;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  calls.length = 0;
  ctx.token = undefined;
  ctx.forwardedProto = null;
  signOut = () => new Response("{}", { status: 200 });
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.SWITCHYARD_ASSUME_HTTPS;
});

describe("logoutAction", () => {
  it("invalidates the Dokploy session, then clears the cookie and redirects", async () => {
    ctx.token = sealed();
    expect(await redirectedTo(logoutAction)).toBe("/login");

    const out = calls.filter((c) => c.path === "/api/auth/sign-out");
    expect(out).toHaveLength(1);
    expect(out[0].method).toBe("POST");
    expect(out[0].cookie).toBe("sess=u1"); // the SEALED session's Dokploy cookie
    expect(out[0].origin).toBeTruthy(); // better-auth CSRF check needs an Origin
    expect(ctx.del).toHaveBeenCalledWith(SESSION_COOKIE);
  });

  it("still clears the cookie and redirects when Dokploy is unreachable", async () => {
    ctx.token = sealed();
    signOut = () => {
      throw new Error("ECONNREFUSED");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await redirectedTo(logoutAction)).toBe("/login");
    expect(ctx.del).toHaveBeenCalledWith(SESSION_COOKIE);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still clears the cookie when Dokploy rejects the sign-out", async () => {
    ctx.token = sealed();
    signOut = () => new Response("nope", { status: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await redirectedTo(logoutAction)).toBe("/login");
    expect(ctx.del).toHaveBeenCalledWith(SESSION_COOKIE);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never calls Dokploy for a forged or missing cookie", async () => {
    ctx.token = "forged-garbage";
    expect(await redirectedTo(logoutAction)).toBe("/login");
    ctx.token = undefined;
    expect(await redirectedTo(logoutAction)).toBe("/login");
    expect(calls).toHaveLength(0);
    expect(ctx.del).toHaveBeenCalledTimes(2);
  });

  it("walks the auth origins when Dokploy answers INVALID_ORIGIN", async () => {
    ctx.token = sealed();
    let attempts = 0;
    signOut = () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({ code: "INVALID_ORIGIN" }), { status: 403 })
        : new Response("{}", { status: 200 });
    };
    expect(await redirectedTo(logoutAction)).toBe("/login");
    const out = calls.filter((c) => c.path === "/api/auth/sign-out");
    expect(out).toHaveLength(2);
    expect(out[0].origin).not.toBe(out[1].origin);
    expect(out.every((c) => c.cookie === "sess=u1")).toBe(true);
  });
});

describe("loginAction cookie Secure attribute", () => {
  const form = () => {
    const fd = new FormData();
    fd.set("email", "u1@example.com");
    fd.set("password", "hunter22");
    return fd;
  };
  const secureFlag = () => (ctx.set.mock.calls[0]?.[2] as { secure?: boolean } | undefined)?.secure;

  it("is plain over HTTP with no proxy header (the localhost default)", async () => {
    expect(await redirectedTo(() => loginAction({}, form()))).toBe("/");
    expect(ctx.set).toHaveBeenCalledTimes(1);
    expect(ctx.set.mock.calls[0][0]).toBe(SESSION_COOKIE);
    expect(secureFlag()).toBe(false);
  });

  it("is Secure behind an HTTPS proxy that sends X-Forwarded-Proto", async () => {
    ctx.forwardedProto = "https";
    expect(await redirectedTo(() => loginAction({}, form()))).toBe("/");
    expect(secureFlag()).toBe(true);
  });

  it("is Secure with SWITCHYARD_ASSUME_HTTPS even without the header", async () => {
    process.env.SWITCHYARD_ASSUME_HTTPS = "1";
    expect(await redirectedTo(() => loginAction({}, form()))).toBe("/");
    expect(secureFlag()).toBe(true);
  });

  it("seals the Dokploy cookie returned by sign-in (never the password)", async () => {
    expect(await redirectedTo(() => loginAction({}, form()))).toBe("/");
    const { openSession } = await import("@/lib/session");
    const token = ctx.set.mock.calls[0][1] as string;
    expect(openSession(token)).toMatchObject({
      dokployCookie: "better-auth.session_token=fresh",
      email: "u1@example.com",
    });
    expect(token).not.toContain("hunter22");
  });
});
