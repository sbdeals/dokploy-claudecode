/**
 * knownAppNames() is the allow-list every container-touching route checks. It
 * is cached for ~30s, and that cache MUST be keyed per session: a shared entry
 * would hand user B the app names user A is allowed to see. These tests drive
 * the real dokploy.ts against a stubbed Dokploy (global fetch) and stubbed
 * request cookies, and also cover the system session the collector runs under.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  /** The sealed switchyard_session value the "current request" carries. */
  token: "" as string,
  cookiesCalls: 0,
  redirect: vi.fn((url: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    ctx.cookiesCalls += 1;
    return {
      get: (name: string) =>
        name === "switchyard_session" && ctx.token ? { name, value: ctx.token } : undefined,
    };
  },
}));
vi.mock("next/navigation", () => ({ redirect: ctx.redirect }));
// No Docker socket in tests: loadWorkspace treats a failing runtime sweep as "unknown".
vi.mock("./docker", () => ({
  listRuntimeStates: async () => {
    throw new Error("no docker in tests");
  },
  deriveComposeRuntime: () => ({ health: "not-running" }),
  deriveSwarmRuntime: () => ({ health: "not-running" }),
}));

// dokploy.ts reads these at import time.
process.env.DOKPLOY_URL = "http://dokploy.test";
process.env.DOKPLOY_EMAIL = "admin@example.com";
process.env.DOKPLOY_PASSWORD = "admin-password";

const { hasSystemCredentials, knownAppNames, listProjects, withSystemSession } = await import("./dokploy");
const { sealSession } = await import("./session");

/** Dokploy cookie -> the single postgres appName that account can see. */
const workspaces: Record<string, string> = {
  "sess=alice": "alpha-db",
  "sess=bob": "beta-db",
  "sess=admin": "gamma-db",
};
const ADMIN_COOKIE = "sess=admin";

const calls: { path: string; cookie: string }[] = [];
let signIns = 0;
let rejectCookie: string | null = null;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    calls.push({ path, cookie });

    if (path === "/api/auth/sign-in/email") {
      signIns += 1;
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": `${ADMIN_COOKIE}; Path=/; HttpOnly` },
      });
    }
    const app = workspaces[cookie];
    if (!app || cookie === rejectCookie) return new Response("unauthorized", { status: 401 });
    if (path === "/api/project.all") {
      return json([
        {
          projectId: "p1",
          name: "Project",
          environments: [
            {
              environmentId: "e1",
              name: "production",
              postgres: [{ postgresId: `pg-${app}` }],
              mysql: [],
              mariadb: [],
              mongo: [],
              redis: [],
              applications: [],
              compose: [],
            },
          ],
        },
      ]);
    }
    if (path.startsWith("/api/postgres.one?")) {
      return json({ name: app, appName: app, applicationStatus: "running" });
    }
    return new Response("not found", { status: 404 });
  }),
);

const sessionFor = (dokployCookie: string) =>
  sealSession({ dokployCookie, email: `${dokployCookie}@example.com`, iat: Date.now() });

const treeWalks = () => calls.filter((c) => c.path === "/api/project.all");

beforeEach(() => {
  calls.length = 0;
  ctx.redirect.mockClear();
});

describe("knownAppNames per-session cache", () => {
  it("keys the allow-list by session: user B never sees user A's cached names", async () => {
    ctx.token = sessionFor("sess=alice");
    const alice = await knownAppNames();
    expect([...alice]).toEqual(["alpha-db"]);

    ctx.token = sessionFor("sess=bob");
    const bob = await knownAppNames();
    expect([...bob]).toEqual(["beta-db"]);
    expect(bob.has("alpha-db")).toBe(false);

    // One tree walk per user, each with that user's own cookie.
    expect(treeWalks().map((c) => c.cookie)).toEqual(["sess=alice", "sess=bob"]);
  });

  it("serves the cached allow-list within the TTL for the SAME session only", async () => {
    ctx.token = sessionFor("sess=alice");
    expect([...(await knownAppNames())]).toEqual(["alpha-db"]);
    expect(treeWalks()).toHaveLength(0); // cache hit from the previous test

    ctx.token = sessionFor("sess=bob");
    expect([...(await knownAppNames())]).toEqual(["beta-db"]);
    expect(treeWalks()).toHaveLength(0);
  });

  it("redirects a forged session to /login instead of serving anyone's cache", async () => {
    ctx.token = "forged";
    await expect(knownAppNames()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(ctx.redirect).toHaveBeenCalledWith("/login");
    expect(calls).toHaveLength(0); // never reached Dokploy
  });

  it("redirects an expired session too", async () => {
    ctx.token = sealSession({
      dokployCookie: "sess=alice",
      email: "alice@example.com",
      iat: Date.now() - 8 * 24 * 60 * 60_000,
    });
    await expect(knownAppNames()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(calls).toHaveLength(0);
  });
});

describe("withSystemSession (background collector)", () => {
  it("reports whether admin credentials exist", () => {
    expect(hasSystemCredentials()).toBe(true);
  });

  it("runs under the admin cookie without reading request cookies", async () => {
    ctx.token = ""; // no request scope to speak of
    const before = ctx.cookiesCalls;
    const names = await withSystemSession(() => knownAppNames());
    expect([...names]).toEqual(["gamma-db"]);
    expect(ctx.cookiesCalls).toBe(before);
    expect(signIns).toBe(1);
    expect(treeWalks().map((c) => c.cookie)).toEqual([ADMIN_COOKIE]);
  });

  it("keeps the system allow-list separate from every user's", async () => {
    ctx.token = sessionFor("sess=alice");
    expect((await knownAppNames()).has("gamma-db")).toBe(false);
  });

  it("reuses the admin cookie, and signs in again after Dokploy rejects it", async () => {
    await withSystemSession(() => listProjects());
    expect(signIns).toBe(1); // cached admin cookie

    rejectCookie = ADMIN_COOKIE;
    await expect(withSystemSession(() => listProjects())).rejects.toThrow(/rejected the system session/);
    expect(ctx.redirect).not.toHaveBeenCalled(); // no request to redirect
    rejectCookie = null;

    await withSystemSession(() => listProjects());
    expect(signIns).toBe(2); // fresh sign-in after the 401
  });
});
