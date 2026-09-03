# P0: process-global allow-list cache leaks across users

knownAppNames() caches the LAST caller's service allow-list for 30s with no session key. alice owns alpha-db, bob owns beta-db (fake Dokploy). Captured 2026-09-03T05:55:22.394Z against http://127.0.0.1:3972. Before: rows 2-4 serve alice's app to bob (200) and row 5 denies bob his own app (403). Expected after the fix: rows 2-4 403, row 5 200, row 6 403.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /api/services/metrics?app=alpha-db` (as ALICE: primes the allow-list cache with {alpha-db}) | **200** |  | `event: unavailable data: {}` |
| 2 | `GET /api/services/metrics?app=alpha-db` (as BOB, within 30s: alpha-db is NOT bob's service) | **200** |  | `event: unavailable data: {}` |
| 3 | `GET /api/services/http-metrics?app=alpha-db` (as BOB) | **200** |  | `{"available":false,"points":[]}` |
| 4 | `GET /api/services/logs?app=alpha-db` (as BOB) | **500** |  |  |
| 5 | `GET /api/services/metrics?app=beta-db` (as BOB: bob's OWN service — served from alice's cached allow-list?) | **403** |  | `unknown app` |
| 6 | `GET /api/services/metrics?app=alpha-db` (as BOB, after the 30s TTL: cache rebuilt from bob's workspace) | **403** |  | `unknown app` |
