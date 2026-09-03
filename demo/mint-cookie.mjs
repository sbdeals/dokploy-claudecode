#!/usr/bin/env node
/**
 * Mint a Switchyard session cookie exactly like dashboard/src/lib/session.ts
 * (AES-256-GCM; key = sha256(secret); base64url(iv12 | tag16 | ciphertext)).
 *
 *   node mint-cookie.mjs <secret> <dokployCookie> <email> [iatMs]
 *
 * Also importable: `import { seal } from "./mint-cookie.mjs"`.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export function seal(secret, session) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(session), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [secret, dokployCookie, email, iat] = process.argv.slice(2);
  if (!secret || !dokployCookie || !email) {
    console.error("usage: mint-cookie.mjs <secret> <dokployCookie> <email> [iatMs]");
    process.exit(1);
  }
  console.log(seal(secret, { dokployCookie, email, iat: iat ? Number(iat) : Date.now() }));
}
