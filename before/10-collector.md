# P1: background collector borrows the first user's request context

Observed (not the 'dies after one tick' hunch): setInterval inherits the async context of the request that started the collector, so every tick calls Dokploy with THAT user's session cookie — here alice's — instead of the DOKPLOY_EMAIL system identity (admin@demo.test). Once that user's Dokploy session ends, ticks hit 401 -> redirect() throws inside a timer -> swallowed; collection stops for good with no log line. Captured 2026-09-03T05:59:01.968Z against http://127.0.0.1:3972. Expected after the fix: window A/B both show project.all as admin (after a sign-in), unaffected by alice's revocation.

## Window A: who does the collector run as?

Window 2026-09-03T05:58:01.957Z -> 2026-09-03T05:58:31.959Z (idle, no browser/API traffic, collector interval 5000ms, ~8 ticks expected).

| Dokploy calls during the window | Count |
|---|---|
| `project.all` as alice -> 200 | **6** |
| sign-ins (`/api/auth/sign-in/email`) | **0** |

```
2026-09-03T05:58:04.878Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:04.882Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
2026-09-03T05:58:09.879Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:09.883Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
2026-09-03T05:58:14.880Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:14.884Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
2026-09-03T05:58:19.880Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:19.882Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
2026-09-03T05:58:24.881Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:24.883Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
2026-09-03T05:58:29.881Z | GET | /api/project.all | alice | 200
2026-09-03T05:58:29.882Z | GET | /api/postgres.one?postgresId=pg-alpha | alice | 200
```

## Window B: after alice's Dokploy session is revoked

Window 2026-09-03T05:58:31.963Z -> 2026-09-03T05:59:01.965Z (idle, no browser/API traffic, collector interval 5000ms, ~8 ticks expected).

| Dokploy calls during the window | Count |
|---|---|
| `project.all` as - -> 401 | **6** |
| sign-ins (`/api/auth/sign-in/email`) | **0** |

```
2026-09-03T05:58:34.882Z | GET | /api/project.all | - | 401
2026-09-03T05:58:39.881Z | GET | /api/project.all | - | 401
2026-09-03T05:58:44.883Z | GET | /api/project.all | - | 401
2026-09-03T05:58:49.883Z | GET | /api/project.all | - | 401
2026-09-03T05:58:54.883Z | GET | /api/project.all | - | 401
2026-09-03T05:58:59.883Z | GET | /api/project.all | - | 401
```
