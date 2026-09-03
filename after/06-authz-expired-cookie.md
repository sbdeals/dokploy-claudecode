# P1: session age never enforced server-side

Cookie correctly sealed for alice but iat = now - 8 days (SESSION_MAX_AGE is 7 days). Captured 2026-09-03T06:06:24.474Z against http://127.0.0.1:3973. Expected after the fix: / redirects to /login (307), /login serves the form (200), API rows 401.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /` (page) | **307** | /login | `<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="preload" as="script" fetchPriority="low" href="/_n` |
| 2 | `GET /login` | **200** |  | `<!DOCTYPE html><html lang="en" class="geist_a71539c9-module__T19VSG__variable geist_mono_8d43a2aa-module__8Li5zG__variable h-full antialiased"><head><meta charSet="utf-8"/><meta name="viewport" conten` |
| 3 | `GET /api/agent/config` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 4 | `GET /api/services/metrics/history?app=alpha-db` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 5 | `GET /api/services/http-metrics?app=alpha-db` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
