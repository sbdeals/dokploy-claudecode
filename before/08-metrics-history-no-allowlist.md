# P0: metrics/history has no service allow-list

Valid sessions, but the route never checks that ?app= belongs to the caller (no durable store is configured here, so bodies are {enabled:false}; with a store they would be real samples). Captured 2026-09-03T05:54:50.212Z against http://127.0.0.1:3972. Expected after the fix: row 1 200, rows 2-4 403.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /api/services/metrics/history?app=alpha-db` (alice's own service) | **200** |  | `{"enabled":false,"samples":[]}` |
| 2 | `GET /api/services/metrics/history?app=beta-db` (bob's service, requested by alice) | **200** |  | `{"enabled":false,"samples":[]}` |
| 3 | `GET /api/services/metrics/history?app=totally-unknown-app` (not a Dokploy service at all) | **200** |  | `{"enabled":false,"samples":[]}` |
| 4 | `GET /api/services/metrics/history?app=alpha-db` (alice's service, requested by bob) | **200** |  | `{"enabled":false,"samples":[]}` |
