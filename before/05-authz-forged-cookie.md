# P0: forged session cookie vs. API routes

Cookie: switchyard_session=forged-garbage (not sealed with the server secret). Captured 2026-09-03T05:54:49.418Z against http://127.0.0.1:3972. Expected after the fix: every row 401.

| # | Request | Status | Location | Body (first 200 chars) |
|---|---|---|---|---|
| 1 | `GET /api/agent/config` | **200** |  | `{"configured":false,"source":null,"masked":null,"loginActive":false,"provider":"anthropic","baseUrl":null,"model":"claude-opus-4-8","models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8","hint":"` |
| 2 | `POST /api/agent/config` (body: set shared agent key) | **200** |  | `{"configured":true,"source":"ui","masked":"sk-ant-d…7890","loginActive":false,"provider":"anthropic","baseUrl":null,"model":"claude-opus-4-8","models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8` |
| 3 | `GET /api/agent/config` (re-read: did the forged key stick?) | **200** |  | `{"configured":true,"source":"ui","masked":"sk-ant-d…7890","loginActive":false,"provider":"anthropic","baseUrl":null,"model":"claude-opus-4-8","models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8` |
| 4 | `POST /api/agent/config` (cleanup: clear key) | **200** |  | `{"configured":false,"source":null,"masked":null,"loginActive":false,"provider":"anthropic","baseUrl":null,"model":"claude-opus-4-8","models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8","hint":"` |
| 5 | `GET /api/agent/models` | **200** |  | `{"provider":"anthropic","dynamic":false,"models":[{"id":"claude-opus-4-8","label":"Claude Opus 4.8"},{"id":"claude-fable-5","label":"Claude Fable 5"},{"id":"claude-sonnet-5","label":"Claude Sonnet 5"}` |
| 6 | `POST /api/agent/oauth/start` | **200** |  | `{"url":"https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=o` |
| 7 | `GET /api/agent/changes` | **200** |  | `{"configured":false,"changes":[]}` |
| 8 | `GET /api/services/metrics/history?app=alpha-db` | **200** |  | `{"enabled":false,"samples":[]}` |
| 9 | `GET /api/services/http-metrics?app=alpha-db` | **200** |  | `{"available":false,"points":[]}` |
| 10 | `GET /api/services/logs?app=alpha-db` | **307** | /login |  |
