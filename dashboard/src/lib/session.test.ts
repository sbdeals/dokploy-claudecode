import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  openSession,
  sealSession,
  sessionFromRequest,
  unauthorized,
  type SwitchyardSession,
} from "./session";

const fresh = (): SwitchyardSession => ({
  dokployCookie: "better-auth.session_token=abc123",
  email: "ada@example.com",
  iat: Date.now(),
});

describe("sealSession / openSession", () => {
  it("round-trips a session", () => {
    const session = fresh();
    expect(openSession(sealSession(session))).toEqual(session);
  });

  it("rejects a tampered token", () => {
    const buf = Buffer.from(sealSession(fresh()), "base64url");
    buf[buf.length - 1] ^= 0x01; // flip one ciphertext bit -> GCM tag mismatch
    expect(openSession(buf.toString("base64url"))).toBeNull();
  });

  it("rejects empty and garbage tokens", () => {
    expect(openSession(undefined)).toBeNull();
    expect(openSession("")).toBeNull();
    expect(openSession("definitely-not-a-token")).toBeNull();
  });

  it("rejects a token sealed with a different secret", () => {
    const prev = process.env.SWITCHYARD_SESSION_SECRET;
    process.env.SWITCHYARD_SESSION_SECRET = "some-other-secret";
    const token = sealSession(fresh());
    process.env.SWITCHYARD_SESSION_SECRET = prev;
    expect(openSession(token)).toBeNull();
  });

  it("rejects a session older than SESSION_MAX_AGE (server-side expiry)", () => {
    const iat = Date.now() - (SESSION_MAX_AGE * 1000 + 1_000);
    expect(openSession(sealSession({ ...fresh(), iat }))).toBeNull();
  });

  it("accepts a session just inside SESSION_MAX_AGE", () => {
    const iat = Date.now() - (SESSION_MAX_AGE * 1000 - 60_000);
    expect(openSession(sealSession({ ...fresh(), iat }))).not.toBeNull();
  });

  it("rejects a session issued implausibly far in the future", () => {
    const now = Date.now();
    expect(openSession(sealSession({ ...fresh(), iat: now + 10 * 60_000 }))).toBeNull();
    // A minute of clock skew is tolerated (the desktop app mints its own cookie).
    expect(openSession(sealSession({ ...fresh(), iat: now + 60_000 }))).not.toBeNull();
  });

  it("rejects a payload without a numeric iat", () => {
    const noIat = { dokployCookie: "a=b", email: "x@y" } as unknown as SwitchyardSession;
    expect(openSession(sealSession(noIat))).toBeNull();
    const stringIat = { ...fresh(), iat: "123" } as unknown as SwitchyardSession;
    expect(openSession(sealSession(stringIat))).toBeNull();
  });

  it("honours an injected clock", () => {
    const iat = 1_700_000_000_000;
    const token = sealSession({ ...fresh(), iat });
    expect(openSession(token, iat + 1_000)).not.toBeNull();
    expect(openSession(token, iat + SESSION_MAX_AGE * 1000 + 1)).toBeNull();
  });
});

describe("sessionFromRequest", () => {
  const request = (cookie?: string) =>
    new Request("http://dashboard.local/api/anything", {
      headers: cookie ? { cookie } : {},
    });

  it("returns the session from a Cookie header with other cookies around it", () => {
    const session = fresh();
    const token = sealSession(session);
    expect(sessionFromRequest(request(`theme=dark; ${SESSION_COOKIE}=${token}; other=1`))).toEqual(
      session,
    );
  });

  it("tolerates a percent-encoded cookie value", () => {
    const session = fresh();
    const token = encodeURIComponent(sealSession(session));
    expect(sessionFromRequest(request(`${SESSION_COOKIE}=${token}`))).toEqual(session);
  });

  it("returns null for a forged value", () => {
    expect(sessionFromRequest(request(`${SESSION_COOKIE}=forged`))).toBeNull();
  });

  it("returns null when the cookie is missing", () => {
    expect(sessionFromRequest(request())).toBeNull();
    expect(sessionFromRequest(request("unrelated=1"))).toBeNull();
    // A cookie whose name merely ends with ours must not match.
    expect(sessionFromRequest(request(`x${SESSION_COOKIE}=${sealSession(fresh())}`))).toBeNull();
  });

  it("returns null for an expired cookie", () => {
    const iat = Date.now() - (SESSION_MAX_AGE * 1000 + 1_000);
    expect(sessionFromRequest(request(`${SESSION_COOKIE}=${sealSession({ ...fresh(), iat })}`))).toBeNull();
  });
});

describe("unauthorized", () => {
  it("is a JSON 401", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Not signed in") });
  });
});
