# P1: background collector borrows the first user's request context

Observed (not the 'dies after one tick' hunch): setInterval inherits the async context of the request that started the collector, so every tick calls Dokploy with THAT user's session cookie — here alice's — instead of the DOKPLOY_EMAIL system identity (admin@demo.test). Once that user's Dokploy session ends, ticks hit 401 -> redirect() throws inside a timer -> swallowed; collection stops for good with no log line. Captured 2026-09-03T06:07:59.571Z against http://127.0.0.1:3973. Expected after the fix: window A/B both show project.all as admin (after a sign-in), unaffected by alice's revocation.

## Window A: who does the collector run as?

Window 2026-09-03T06:06:59.562Z -> 2026-09-03T06:07:29.564Z (idle, no browser/API traffic, collector interval 5000ms, ~8 ticks expected).

| Dokploy calls during the window | Count |
|---|---|
| `project.all` as admin -> 200 | **6** |
| sign-ins (`/api/auth/sign-in/email`) | **0** |

```
2026-09-03T06:07:01.168Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:01.170Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:01.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:06.168Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:06.170Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:06.172Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:11.168Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:11.170Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:11.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:16.168Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:16.170Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:16.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:21.169Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:21.171Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:21.172Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:26.169Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:26.171Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:26.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
```

## Window B: after alice's Dokploy session is revoked

Window 2026-09-03T06:07:29.568Z -> 2026-09-03T06:07:59.569Z (idle, no browser/API traffic, collector interval 5000ms, ~8 ticks expected).

| Dokploy calls during the window | Count |
|---|---|
| `project.all` as admin -> 200 | **6** |
| sign-ins (`/api/auth/sign-in/email`) | **0** |

```
2026-09-03T06:07:31.169Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:31.170Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:31.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:36.169Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:36.171Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:36.171Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:41.170Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:41.171Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:41.172Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:46.170Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:46.171Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:46.172Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:51.170Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:51.174Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:51.174Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
2026-09-03T06:07:56.170Z | GET | /api/project.all | admin | 200
2026-09-03T06:07:56.172Z | GET | /api/postgres.one?postgresId=pg-alpha | admin | 200
2026-09-03T06:07:56.173Z | GET | /api/postgres.one?postgresId=pg-beta | admin | 200
```
