# P0: http-metrics falls OPEN when the allow-list can't be built

Fake Dokploy stopped before these requests. Captured 2026-09-03T06:08:13.637Z against http://127.0.0.1:3973. Before: http-metrics answers 200 for any app name (known=null skips the check). Expected after the fix: 503 for rows 1-2 (fail closed), row 3 unchanged.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /api/services/http-metrics?app=alpha-db` (valid session, Dokploy UNREACHABLE) | **503** |  | `{"available":false,"points":[],"error":"workspace unavailable"}` |
| 2 | `GET /api/services/http-metrics?app=anything-at-all` (valid session, Dokploy UNREACHABLE, arbitrary app) | **503** |  | `{"available":false,"points":[],"error":"workspace unavailable"}` |
| 3 | `GET /api/services/metrics?app=alpha-db` (control: the live metrics route already fails closed) | **503** |  | `workspace unavailable` |
