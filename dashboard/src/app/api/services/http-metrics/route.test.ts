import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  knownAppNames: vi.fn<() => Promise<Set<string>>>(),
  getHttpMetrics: vi.fn<(app: string, range: number) => { available: boolean; points: unknown[] }>(),
}));

vi.mock("@/lib/dokploy", () => ({ knownAppNames: mocks.knownAppNames }));
vi.mock("@/lib/traefik-metrics", () => ({ getHttpMetrics: mocks.getHttpMetrics }));

import { SESSION_COOKIE, sealSession } from "@/lib/session";
import { GET } from "./route";

const cookie = () =>
  `${SESSION_COOKIE}=${sealSession({ dokployCookie: "sess=u1", email: "u1@example.com", iat: Date.now() })}`;

const get = (cookieHeader: string | undefined, app = "web") =>
  GET(
    new Request(`http://dashboard.local/api/services/http-metrics?app=${app}&range=30`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    }),
  );

const nextRedirect = () =>
  Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.knownAppNames.mockResolvedValue(new Set(["web"]));
  mocks.getHttpMetrics.mockReturnValue({ available: true, points: [{ ts: 1, requests: 3 }] });
});

describe("GET /api/services/http-metrics", () => {
  it("401s a forged cookie before any lookup", async () => {
    expect((await get(`${SESSION_COOKIE}=forged`)).status).toBe(401);
    expect(mocks.knownAppNames).not.toHaveBeenCalled();
    expect(mocks.getHttpMetrics).not.toHaveBeenCalled();
  });

  it("fails CLOSED (503) when the allow-list can't be built — no metrics leak", async () => {
    mocks.knownAppNames.mockRejectedValue(new Error("Dokploy unreachable"));
    const res = await get(cookie());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ available: false, points: [] });
    expect(mocks.getHttpMetrics).not.toHaveBeenCalled();
  });

  it("propagates a framework redirect (rejected session) instead of swallowing it", async () => {
    mocks.knownAppNames.mockRejectedValue(nextRedirect());
    await expect(get(cookie())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(mocks.getHttpMetrics).not.toHaveBeenCalled();
  });

  it("403s an app outside the user's workspace with the panel's empty shape", async () => {
    const res = await get(cookie(), "not-mine");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ available: false, points: [] });
    expect(mocks.getHttpMetrics).not.toHaveBeenCalled();
  });

  it("serves metrics for an allowed app", async () => {
    const res = await get(cookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, points: [{ ts: 1, requests: 3 }] });
    expect(mocks.getHttpMetrics).toHaveBeenCalledWith("web", 30);
  });
});
