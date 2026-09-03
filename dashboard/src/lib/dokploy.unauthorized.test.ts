/**
 * Every cookie-authenticated Dokploy fetch must treat a 401 the same way:
 * under the system session (background collector) throw and drop the cached
 * admin cookie — there is no request to redirect — and on a user request
 * redirect to /login. `request()` did this already; `restoreBackup()` (the
 * SSE fetch, which bypasses `request()`) used to redirect unconditionally.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  token: "" as string,
  redirect: vi.fn((url: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "switchyard_session" && ctx.token ? { name, value: ctx.token } : undefined,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: ctx.redirect }));
vi.mock("./docker", () => ({
  listRuntimeStates: async () => {
    throw new Error("no docker in tests");
  },
  deriveComposeRuntime: () => ({ health: "not-running" }),
  deriveSwarmRuntime: () => ({ health: "not-running" }),
}));

process.env.DOKPLOY_URL = "http://dokploy.test";
process.env.DOKPLOY_EMAIL = "admin@example.com";
process.env.DOKPLOY_PASSWORD = "admin-password";

const { listProjects, restoreBackup, withSystemSession } = await import("./dokploy");
const { sealSession } = await import("./session");

let signIns = 0;
const calls: { path: string; cookie: string }[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    calls.push({ path: url.pathname, cookie });
    if (url.pathname === "/api/auth/sign-in/email") {
      signIns += 1;
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "sess=admin; Path=/; HttpOnly" },
      });
    }
    // Every authenticated call is rejected: the session is gone.
    return new Response("Unauthorized", { status: 401 });
  }),
);

const restore = () =>
  restoreBackup({
    engine: "postgres",
    databaseId: "db1",
    databaseName: "app",
    backupFile: "backups/app.sql.gz",
    destinationId: "s3-1",
  });

beforeEach(() => {
  calls.length = 0;
  signIns = 0;
  ctx.token = "";
  vi.clearAllMocks();
});

describe("restoreBackup on a Dokploy 401", () => {
  it("throws under the system session instead of redirecting, and forgets the admin cookie", async () => {
    await expect(withSystemSession(restore)).rejects.toThrow(/rejected the system session/);
    expect(ctx.redirect).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path.includes("backup.restoreBackupWithLogs"))?.cookie).toBe("sess=admin");

    // The cached admin cookie was dropped: the next system call signs in afresh.
    await expect(withSystemSession(restore)).rejects.toThrow(/rejected the system session/);
    expect(signIns).toBe(2);
  });

  it("redirects a user request to /login", async () => {
    ctx.token = sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat: Date.now() });
    await expect(restore()).rejects.toMatchObject({ digest: expect.stringContaining("/login") });
    expect(ctx.redirect).toHaveBeenCalledWith("/login");
    expect(calls.find((c) => c.path.includes("backup.restoreBackupWithLogs"))?.cookie).toBe("sess=u1");
    expect(signIns).toBe(0); // never falls back to the admin session
  });
});

describe("request() on a Dokploy 401 (same helper)", () => {
  it("throws under the system session and redirects a user", async () => {
    await expect(withSystemSession(listProjects)).rejects.toThrow(/rejected the system session/);
    expect(ctx.redirect).not.toHaveBeenCalled();

    ctx.token = sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat: Date.now() });
    await expect(listProjects()).rejects.toMatchObject({ digest: expect.stringContaining("/login") });
    expect(ctx.redirect).toHaveBeenCalledWith("/login");
  });
});
