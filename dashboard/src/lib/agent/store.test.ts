/**
 * The staged-change queue is partitioned by sessionKey(), which must derive
 * from the VERIFIED session (the opened seal), not the raw cookie header: a
 * caller re-encoding the same cookie must land in the same partition, and the
 * raw token must never be the map key.
 */
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE, sealSession, sessionFromRequest } from "@/lib/session";
import { addStaged, listStaged, removeStaged, sessionKey } from "./store";

const session = (dokployCookie: string, email = "ada@example.com") => ({
  dokployCookie,
  email,
  iat: Date.now(),
});

const withCookie = (cookieHeader: string) =>
  new Request("http://dashboard.local/api/agent/changes", { headers: { cookie: cookieHeader } });

describe("sessionKey", () => {
  it("is the same for one session however the cookie header encodes it", () => {
    const token = sealSession(session("sess=alice"));
    const plain = sessionFromRequest(withCookie(`theme=dark; ${SESSION_COOKIE}=${token}`));
    const encoded = sessionFromRequest(withCookie(`${SESSION_COOKIE}=${encodeURIComponent(token)}`));
    expect(plain).not.toBeNull();
    expect(encoded).not.toBeNull();
    expect(sessionKey(plain!)).toBe(sessionKey(encoded!));
    expect(sessionKey(plain!)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs per Dokploy login and never contains the raw token", () => {
    const a = sessionKey(session("sess=alice"));
    const b = sessionKey(session("sess=bob"));
    expect(a).not.toBe(b);
    // Same login seen twice (e.g. a re-issued seal for the same Dokploy session) -> same partition.
    expect(sessionKey(session("sess=alice", "other-display@example.com"))).toBe(a);
    expect(a).not.toContain("sess=alice");
  });

  it("partitions the queue between two verified sessions", () => {
    const a = sessionKey(session("sess=alice"));
    const b = sessionKey(session("sess=bob"));
    const change = addStaged(a, { kind: "stop_service", params: { id: "x" }, description: "stop x" });
    expect(listStaged(a).map((c) => c.id)).toEqual([change.id]);
    expect(listStaged(b)).toEqual([]);
    removeStaged(a, [change.id]);
    expect(listStaged(a)).toEqual([]);
  });
});
