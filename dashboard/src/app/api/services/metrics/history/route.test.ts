import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  knownAppNames: vi.fn<() => Promise<Set<string>>>(),
  storeEnabled: vi.fn<() => boolean>(),
  queryMetrics: vi.fn<(app: string, since: number, until: number) => Promise<unknown[]>>(),
}));

vi.mock("@/lib/dokploy", () => ({ knownAppNames: mocks.knownAppNames }));
vi.mock("@/lib/store", () => ({
  storeEnabled: mocks.storeEnabled,
  queryMetrics: mocks.queryMetrics,
}));

import { SESSION_COOKIE, SESSION_MAX_AGE, sealSession } from "@/lib/session";
import { GET } from "./route";

const cookieFor = (iat = Date.now()) =>
  `${SESSION_COOKIE}=${sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat })}`;

const get = (cookie: string | undefined, app: string | null = "alpha-db") =>
  GET(
    new Request(
      `http://dashboard.local/api/services/metrics/history${app === null ? "" : `?app=${app}`}`,
      { headers: cookie ? { cookie } : {} },
    ),
  );

/** What `redirect("/login")` throws inside Next: unstable_rethrow must let it through. */
const nextRedirect = () =>
  Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.storeEnabled.mockReturnValue(true);
  mocks.queryMetrics.mockResolvedValue([{ ts: 1, cpu: 0.1 }]);
  mocks.knownAppNames.mockResolvedValue(new Set(["alpha-db"]));
});

describe("GET /api/services/metrics/history", () => {
  it("401s a forged cookie without consulting the workspace or the store", async () => {
    const res = await get(`${SESSION_COOKIE}=forged`);
    expect(res.status).toBe(401);
    expect(mocks.knownAppNames).not.toHaveBeenCalled();
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });

  it("401s when there is no cookie at all", async () => {
    expect((await get(undefined)).status).toBe(401);
  });

  it("401s an expired cookie", async () => {
    const res = await get(cookieFor(Date.now() - (SESSION_MAX_AGE * 1000 + 1_000)));
    expect(res.status).toBe(401);
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });

  it("400s a missing ?app after the session check", async () => {
    expect((await get(cookieFor(), null)).status).toBe(400);
  });

  it("fails closed (503) when the allow-list can't be built", async () => {
    mocks.knownAppNames.mockRejectedValue(new Error("Dokploy unreachable"));
    const res = await get(cookieFor());
    expect(res.status).toBe(503);
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });

  it("propagates a framework redirect instead of masking it as 503", async () => {
    mocks.knownAppNames.mockRejectedValue(nextRedirect());
    await expect(get(cookieFor())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });

  it("403s an app outside the user's workspace and never touches the store", async () => {
    const res = await get(cookieFor(), "someone-elses-db");
    expect(res.status).toBe(403);
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });

  it("serves history for an allowed app", async () => {
    const res = await get(cookieFor());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, samples: [{ ts: 1, cpu: 0.1 }] });
    expect(mocks.queryMetrics).toHaveBeenCalledWith("alpha-db", expect.any(Number), expect.any(Number));
  });

  it("reports enabled:false without a store — but only for an allowed app", async () => {
    mocks.storeEnabled.mockReturnValue(false);
    expect(await (await get(cookieFor())).json()).toEqual({ enabled: false, samples: [] });
    expect((await get(cookieFor(), "someone-elses-db")).status).toBe(403);
  });
});
