# P1: session age never enforced server-side

Cookie correctly sealed for alice but iat = now - 8 days (SESSION_MAX_AGE is 7 days). Captured 2026-09-03T05:54:50.025Z against http://127.0.0.1:3972. Expected after the fix: / redirects to /login (307), /login serves the form (200), API rows 401.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /` (page) | **200** |  | `<!DOCTYPE html><html lang="en" class="geist_a71539c9-module__T19VSG__variable geist_mono_8d43a2aa-module__8Li5zG__variable h-full antialiased"><head><meta charSet="utf-8"/><meta name="viewport" conten` |
| 2 | `GET /login` | **307** | / | `<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="preload" as="script" fetchPriority="low" href="/_n` |
| 3 | `GET /api/agent/config` | **200** |  | `{"configured":false,"source":null,"masked":null,"loginActive":false,"provider":"anthropic","baseUrl":null,"model":"claude-opus-4-8","models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8","hint":"` |
| 4 | `GET /api/services/metrics/history?app=alpha-db` | **200** |  | `{"enabled":false,"samples":[]}` |
| 5 | `GET /api/services/http-metrics?app=alpha-db` | **200** |  | `{"available":false,"points":[]}` |
