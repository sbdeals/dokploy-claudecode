# P0: forged session cookie vs. API routes

Cookie: switchyard_session=forged-garbage (not sealed with the server secret). Captured 2026-09-03T06:06:24.223Z against http://127.0.0.1:3973. Expected after the fix: every row 401.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /api/agent/config` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 2 | `POST /api/agent/config` (body: set shared agent key) | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 3 | `GET /api/agent/config` (re-read: did the forged key stick?) | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 4 | `POST /api/agent/config` (cleanup: clear key) | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 5 | `GET /api/agent/models` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 6 | `POST /api/agent/oauth/start` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 7 | `GET /api/agent/changes` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 8 | `GET /api/services/metrics/history?app=alpha-db` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 9 | `GET /api/services/http-metrics?app=alpha-db` | **401** |  | `{"error":"Not signed in. Sign in at /login."}` |
| 10 | `GET /api/services/logs?app=alpha-db` | **307** | /login |  |
