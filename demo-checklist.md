# Switchyard hardening: demo checklist

Before/after evidence for the hardening PR. Everything here was captured on a
machine with no Docker and no Dokploy, against a tiny fake Dokploy API
(`demo/fake-dokploy.mjs`), so the screenshots show the dashboard's own
behaviour (auth, routing, copy), not real containers. Live metrics/logs tabs
therefore render "unavailable" in both passes; that is expected.

- `before/` was captured from the untouched `main` tip (`1fc46d5`).
- `after/` was captured from the PR branch `harden/authz-docs-polish` (`460679d`).
- Same file names in both folders; open them side by side.
- Every `after` result matched its expected value. No mismatches.

## Findings: before vs. after

| # | Finding | Sev | Before (observed on main) | After (observed on the branch) |
|---|---|---|---|---|
| 05 | Forged (unsigned) `switchyard_session` cookie accepted by `/api/agent/*` (config GET/POST, models, oauth/start, changes), `/api/services/metrics/history`, `/api/services/http-metrics`. A forged cookie could SET the shared agent API key. | P0 | [png](before/05-authz-forged-cookie.png) / [md](before/05-authz-forged-cookie.md): rows 1-9 **200**; the forged `POST {key}` stuck (`configured:true`); logs 307 | [png](after/05-authz-forged-cookie.png) / [md](after/05-authz-forged-cookie.md): rows 1-9 **401** `Not signed in`; logs 307 |
| 07 | `knownAppNames()` allow-list cache was process-global (30 s TTL, no session key): bob was served alice's service and denied his own. | P0 | [png](before/07-cross-user-allowlist.png) / [md](before/07-cross-user-allowlist.md): bob on alice's app = **200 / 200 / 500**; bob on his OWN app = **403** | [png](after/07-cross-user-allowlist.png) / [md](after/07-cross-user-allowlist.md): bob on alice's app = **403 / 403 / 403**; bob on his own app = **200**; after TTL still 403 |
| 08 | `/api/services/metrics/history` had no service allow-list. | P0 | [png](before/08-metrics-history-no-allowlist.png): own / bob's / unknown / cross-user app = **200 / 200 / 200 / 200** | [png](after/08-metrics-history-no-allowlist.png): **200 / 403 / 403 / 403** |
| 09 | `/api/services/http-metrics` failed OPEN when the allow-list couldn't be built (Dokploy down or session rejected). | P0 | [png](before/09-http-metrics-fail-open.png): Dokploy down, any app name = **200** | [png](after/09-http-metrics-fail-open.png): **503** `workspace unavailable` (same as the live metrics route) |
| 06 | Session `iat` / `SESSION_MAX_AGE` never enforced server-side: an 8-day-old cookie still opened the workspace and the APIs. | P1 | [png](before/06-authz-expired-cookie.png): `/` **200**, `/login` **307 -> /**, APIs **200** | [png](after/06-authz-expired-cookie.png): `/` **307 -> /login**, `/login` **200**, APIs **401** |
| 10 | Background collector ran under the FIRST user's request context. (Observed on main, not the "dies after one tick" hunch: `setInterval` inherits the request's async context, so every tick called Dokploy with alice's session cookie, never `DOKPLOY_EMAIL`, with zero sign-ins; once alice's Dokploy session was revoked every tick 401'd forever with no recovery.) | P1 | [png](before/10-collector.png) / [md](before/10-collector.md): window A `project.all` as **alice**, 0 sign-ins; window B (alice revoked) **6 x 401**, still no sign-in | [png](after/10-collector.png) / [md](after/10-collector.md): signs in once as **admin@demo.test** when the collector starts (cached system session), then every tick runs `project.all` as **admin -> 200** covering both projects; window B unaffected by alice's revocation |
| 11 | Session cookie never got `Secure`, even behind an HTTPS proxy. | P1 | [md](before/11-secure-cookie.md): `secure=false` with `X-Forwarded-Proto: https` | [md](after/11-secure-cookie.md): `secure=true` behind the proxy; plain HTTP unchanged (`false`, so 127.0.0.1 keeps working) |
| 00 | Tab title was "Switchyard — Databases" on every page. | P2 | [md](before/00-titles.md): `Switchyard — Databases` on /login and / | [md](after/00-titles.md): `Sign in · Switchyard` on /login, `Switchyard` on / |
| 01/02 | Login screen: hamburger-style mark; h1 stayed "Sign in to Switchyard" in create-account mode. | P2 | [01](before/01-login-signin.png), [02](before/02-login-signup.png): three-bar icon; h1 `Sign in to Switchyard` in both modes | [01](after/01-login-signin.png), [02](after/02-login-signup.png): rail-switch brand mark; h1 `Create your Switchyard account` in create mode, hint copy follows the mode |
| 03 | Workspace after a real form sign-in (proves the fake Dokploy + session flow end to end). | ref | [03](before/03-workspace-alice.png) | [03](after/03-workspace-alice.png): identical canvas, new title |
| 04 | Error card told the user to check `DOKPLOY_EMAIL` / `DOKPLOY_PASSWORD`, which no longer authenticate the UI. | P2 | [png](before/04-error-card.png) / [md](before/04-error-card.md): "…that DOKPLOY_URL, DOKPLOY_EMAIL and DOKPLOY_PASSWORD are correct…" | [png](after/04-error-card.png) / [md](after/04-error-card.md): "…couldn't talk to the Dokploy API with your session. Check that Dokploy is running and that DOKPLOY_URL points at it… If Dokploy is up, sign out and back in at /login." |

Not demonstrable here (covered by the PR's unit tests / docs instead): the
per-session cache and session-expiry unit tests under `dashboard/src/**`, the
docs/README changes, the Node engines bump, and `postgres/route.ts` rethrowing
the auth redirect (needs a Postgres container).

## PR body snippet

Paste-ready (paths are relative to `/Users/eliyumn/Desktop/switchyard-harden-artifacts/`):

```markdown
### Demo evidence (before = main 1fc46d5, after = this branch)

Captured against a fake Dokploy (`demo/fake-dokploy.mjs`) with two users who own one service each; no Docker involved. Checklist and repro scripts: `demo-checklist.md`, `demo/`.

| Finding | Before | After | Observed after the fix |
|---|---|---|---|
| P0 forged cookie accepted by agent/metrics routes | `before/05-authz-forged-cookie.png` | `after/05-authz-forged-cookie.png` | every route 401; a forged POST can no longer set the shared agent key |
| P0 cross-user allow-list cache leak | `before/07-cross-user-allowlist.png` | `after/07-cross-user-allowlist.png` | bob gets 403 on alice's app and 200 on his own, inside and outside the 30 s TTL |
| P0 metrics/history had no allow-list | `before/08-metrics-history-no-allowlist.png` | `after/08-metrics-history-no-allowlist.png` | own app 200; other user's / unknown app 403 |
| P0 http-metrics failed open | `before/09-http-metrics-fail-open.png` | `after/09-http-metrics-fail-open.png` | Dokploy unreachable -> 503, not 200 |
| P1 session age not enforced | `before/06-authz-expired-cookie.png` | `after/06-authz-expired-cookie.png` | 8-day-old cookie: `/` -> 307 /login, APIs 401 |
| P1 collector ran as the first user | `before/10-collector.png` | `after/10-collector.png` | ticks run as the DOKPLOY_EMAIL system session (admin), unaffected by that user's Dokploy session ending |
| P1 cookie never Secure | `before/11-secure-cookie.md` | `after/11-secure-cookie.md` | `secure=true` behind an HTTPS proxy (`X-Forwarded-Proto: https`); plain HTTP unchanged |
| P2 tab title | `before/00-titles.md` | `after/00-titles.md` | `Sign in · Switchyard` / `Switchyard` instead of `Switchyard — Databases` |
| P2 login mark + create-account heading | `before/02-login-signup.png` | `after/02-login-signup.png` | real brand mark; h1 follows the mode |
| P2 error-card copy | `before/04-error-card.png` | `after/04-error-card.png` | points at DOKPLOY_URL and /login, not the admin credentials |
```

## How to reproduce

All scripts live in `demo/` and take the dashboard base URL + output dir.
They need Node 22 and `playwright-core` (browser = the Chromium that Playwright
already cached under `~/Library/Caches/ms-playwright/chromium-1228`; set
`CHROME_PATH` to any Chrome/Chromium binary otherwise, and `PW_DIR` to a folder
where `npm i playwright-core` was run).

```bash
ART=/Users/eliyumn/Desktop/switchyard-harden-artifacts
TMP=/Users/eliyumn/.claude/jobs/b0cd646f/tmp/demo        # any scratch dir

# 1. fake Dokploy (three users: alice/bob own one service each, admin owns both)
PORT=3971 FAKE_DOKPLOY_LOG=$TMP/fake-dokploy.log node $ART/demo/fake-dokploy.mjs &

# 2. the dashboard under test (before: a `git archive` of main; after: the PR branch)
cd <dashboard dir> && npx next build && \
DOKPLOY_URL=http://127.0.0.1:3971 DOKPLOY_EMAIL=admin@demo.test DOKPLOY_PASSWORD=password-admin \
SWITCHYARD_SESSION_SECRET=demo-secret-do-not-use SWITCHYARD_COLLECT_INTERVAL_MS=5000 \
npx next start -p 3972 &

# 3. captures (stub UP)
cd $ART/demo
node capture.mjs pages http://127.0.0.1:3972 $ART/before        # 01 02 03 11 + 00-titles.md
node transcripts.mjs online http://127.0.0.1:3972 $ART/before   # 05 06 08 07 (07 waits 32 s for the cache TTL)
node transcripts.mjs collector http://127.0.0.1:3972 $ART/before $TMP/fake-dokploy.log   # 10 (two 30 s idle windows)

# 4. captures (stub DOWN): kill the fake Dokploy first
node transcripts.mjs failopen http://127.0.0.1:3972 $ART/before  # 09
node capture.mjs error http://127.0.0.1:3972 $ART/before         # 04
```

The after pass used the same commands with port 3973 and `$ART/after`.

Notes:

- `next start` warns that the dashboard uses `output: standalone`; it still
  serves. `node .next/standalone/server.js` works too.
- A snapshot's `node_modules` must be a real copy (`cp -Rc`), not a symlink:
  Turbopack refuses a `node_modules` symlink that points outside the project.
- Session cookies are minted by `demo/mint-cookie.mjs`, which mirrors
  `dashboard/src/lib/session.ts` byte for byte (also how the desktop app does
  auto-login).
- The collector run needs the dashboard started with
  `DOKPLOY_EMAIL=admin@demo.test` so the system identity differs from the
  first user to open the workspace (alice). `POST /__demo/revoke?token=alice`
  on the stub simulates that user's Dokploy session ending.
