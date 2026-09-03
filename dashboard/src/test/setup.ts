// Shared vitest setup. The session module derives its AES key from this secret
// at call time, so any value set before the first seal/open is enough.
process.env.SWITCHYARD_SESSION_SECRET ??= "vitest-session-secret";
