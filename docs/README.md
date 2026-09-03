# Documentation

Docs for **Switchyard** — an open-source, Railway-style PaaS built on [Dokploy](https://dokploy.com) and driven by Claude Code: the dashboard, the `switchyard-cli` installer, the launch tooling, and the MCP server. (Repo slug: `sbdeals/switchyard`.)

| Doc | Read it when you want to… |
|---|---|
| [CLI reference](cli.md) | Use the one-command installer (`npx switchyard-cli up` / `install.sh`): commands, flags, the config file, security notes, migrations |
| [Getting started](getting-started.md) | Install and run the stack — the fast path on any platform, or manually (Linux `make up`, Windows 11 Docker Desktop) — and connect the dashboard |
| [Dashboard guide](dashboard-guide.md) | Tour every Switchyard feature: canvas, databases, applications, compose stacks, logs, metrics, projects |
| [Architecture](architecture.md) | Understand how Switchyard works: the BFF over the Dokploy API, Server Actions, SSE logs/metrics, canvas edge inference |
| [Launch tooling](launch-tooling.md) | Use or modify the `make` targets and `scripts/` that install and manage the Dokploy stack on a Linux host |
| [Troubleshooting](troubleshooting.md) | Fix a specific failure — port conflicts, Swarm mount rejections, crash loops, Windows quirks |

## Quick orientation

```
browser ──> Switchyard (Next.js BFF, :3001) ──> Dokploy API (:3000)
                       └──────────────────────> Docker Engine API (logs/metrics)
```

- **Switchyard** lives in [`dashboard/`](../dashboard/) — see its [README](../dashboard/README.md) for the code-level layout.
- The **launch scripts** live in [`scripts/`](../scripts/) and are driven by the root [`Makefile`](../Makefile).
- Screenshots in these docs come from a live local deployment (Dokploy in Docker Swarm + Switchyard in dev mode).

> **Security note:** Switchyard requires a per-user Dokploy login at `/login`, but a login gate is not TLS. A signed-in user holds full admin over Dokploy, including database passwords and container logs, and the dashboard speaks plain HTTP. Keep it on localhost (the default) or put an HTTPS proxy in front before exposing it.
