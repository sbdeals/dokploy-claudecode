# Switchyard MCP server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server
(stdio) that exposes **Dokploy** operations as tools, so **Claude Code** can
drive the Switchyard PaaS directly — deploy an app, add a domain, read its
logs — without opening the dashboard.

This delivers the "driven by Claude Code" promise as a real capability, not just
a launcher. It is a focused subset of the [dashboard](../dashboard/), not
parity: exactly the 11 tools in the table below (deploy, lifecycle, logs, one
metrics sample, env, a single domain attach, database creation). The dashboard
does a lot the server does not expose: backups and S3 destinations, cron
schedules, volume mounts, private-repo deploys via the GitHub App, the template
catalog, deployment history and rollbacks, build configuration, redirects /
ports / basic-auth, domain edits beyond one attach, notification channels, and
the in-dashboard agent.

## How it fits

- **Control plane** — talks to the Dokploy API over RPC-style HTTP, mirroring
  the dashboard's client (`dashboard/src/lib/dokploy.ts`): admin sign-in,
  cached session cookie, `Origin` header for better-auth's CSRF check, retry
  once on 401. It's a separate process, so it can't import the Next module — it
  ships its own small client ([`src/dokploy.ts`](src/dokploy.ts)).
- **Data plane** — reads container logs and a metrics sample straight from the
  Docker engine via `dockerode` ([`src/docker.ts`](src/docker.ts)), the same
  approach as `dashboard/src/lib/docker.ts`. Logs/metrics come from Docker, not
  Dokploy.
- **Transport** — stdio only. Nothing is bound to a network port, so this does
  not change Switchyard's 127.0.0.1-default exposure model.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | List projects and their environments (get `environmentId` values). |
| `list_services` | List every service (db/app/compose) with id, name, appName, status, scope. |
| `deploy_image` | Create + deploy an application from a public Docker image. |
| `deploy_repo` | Create + deploy an application from a public Git repo (Nixpacks build). |
| `deploy_compose` | Create + deploy a docker-compose stack from a YAML string. |
| `service_action` | Run a lifecycle action: `deploy` / `start` / `stop` / `remove` (remove is destructive). |
| `get_logs` | Bounded tail of a service's container logs (from the Docker socket). |
| `get_metrics` | A single CPU/memory sample for a service's container. |
| `manage_env` | Read or replace a service's raw env block (databases & applications). |
| `manage_domain` | Attach a domain to an application, with Let's Encrypt HTTPS. |
| `create_database` | Provision one of postgres / mysql / mariadb / mongo / redis and deploy it. |

`get_logs`, `get_metrics`, `service_action`, `manage_env`, and `manage_domain`
accept a `service` argument that matches by id, exact `appName`/`name`, then
substring — so after a deploy you can pass the name straight through.

## Configuration

Reads the same env vars as the dashboard:

| Env var | Default | Meaning |
|---|---|---|
| `DOKPLOY_URL` | `http://localhost:3000` | Dokploy base URL |
| `DOKPLOY_ORIGIN` | `DOKPLOY_URL` | Origin header for better-auth CSRF (set when reaching Dokploy over service DNS) |
| `DOKPLOY_EMAIL` | — | Dokploy admin email |
| `DOKPLOY_PASSWORD` | — | Dokploy admin password |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine socket; `//./pipe/docker_engine` on Windows |

## Build & run

```sh
cd mcp
npm install
npm run build      # tsc -> dist/
npm run typecheck
npm test           # builds, then asserts the tool list over an in-memory MCP client
```

Claude Code picks the server up automatically from the repo-root
[`.mcp.json`](../.mcp.json) when you run `make claude` (or start Claude Code in
the repo). That config runs `node mcp/dist/index.js` and passes the `DOKPLOY_*`
/ `DOCKER_SOCKET` env through, so **build the server once** (`npm run build`)
and export your Dokploy admin credentials before launching.

### Try it end-to-end

With the stack up (`make up`) and credentials exported:

1. `make claude`
2. Ask Claude to call `deploy_repo` with a public repo URL (or `deploy_image`
   with e.g. `nginx:alpine`).
3. Ask Claude to call `get_logs` for the service it just returned.

No dashboard clicks required.
