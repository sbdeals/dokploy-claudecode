# P1: session cookie never marked Secure

Signed in as alice through the real form, then read the cookie jar. Captured 2026-09-03T05:54:48.771Z against http://127.0.0.1:3972.

| Sign-in over | cookie set | secure | httpOnly | sameSite |
|---|---|---|---|---|
| plain HTTP (localhost default) | yes | false | true | Lax |
| HTTP with `X-Forwarded-Proto: https` (behind an HTTPS proxy, e.g. `--expose` + TLS terminator) | yes | false | true | Lax |

Expected: plain HTTP stays `secure=false` (the cookie must still work on http://127.0.0.1). Behind an HTTPS proxy the fix sets `secure=true` so the browser never sends the session over clear HTTP.
