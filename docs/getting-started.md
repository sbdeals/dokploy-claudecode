# Getting started

This guide takes you from a clean machine to a working stack: **Dokploy** (the
upstream PaaS engine) plus **Switchyard** (this repo's Railway-style dashboard
in [`dashboard/`](../dashboard/)).

**On Windows or macOS, the easiest route is the [desktop app](../README.md#windows--macos--the-desktop-app-easiest-no-terminal)**
— download, double-click, done (it installs Docker Desktop for you if needed).
Everything below is for Linux, for terminal users, and for contributors.

**Otherwise start with the [fast path](#fast-path-one-command-all-platforms)** —
one command on every supported platform. The manual procedures it automates are
kept below as appendices, for contributors and for when you want to see every
step:

- **[Path A: Linux server](#path-a-linux-server)** — the repo's native manual
  path, driven by `make` and the scripts in [`scripts/`](../scripts/).
- **[Path B: Windows 11 with Docker Desktop](#path-b-windows-11-with-docker-desktop)** —
  replaying the installer's core steps against Docker Desktop by hand. Tested
  end-to-end on a real Windows 11 machine (2026-07-01). macOS shares this
  Docker Desktop code path but has not yet been verified end-to-end.

Afterwards, run the [verification checklist](#verification-checklist). For how
the pieces fit together, see [architecture.md](architecture.md); for a deep
dive into the `make` targets and scripts, see
[launch-tooling.md](launch-tooling.md).

## Fast path: one command (all platforms)

**Linux** (fresh server or VPS — installs Docker and Node.js if missing):

```bash
curl -fsSL https://raw.githubusercontent.com/sbdeals/switchyard/main/install.sh | bash
```

**Windows 11 / macOS** (Docker Desktop running, Node 20+ installed):

```powershell
npx switchyard-cli up
```

> **macOS:** this shares Path B's Docker Desktop code path but hasn't been
> hand-tested end-to-end yet — the verification procedure is in
> [macos-verification.md](macos-verification.md).

The CLI then does everything this guide's manual paths describe:

1. Checks prerequisites and catches port conflicts up front (an existing
   Dokploy install has its published port adopted automatically).
2. Stands up the Dokploy stack — on Linux via the same `scripts/dokploy-up.sh`
   that `make up` runs; on Docker Desktop by replaying Path B programmatically.
3. Asks you for the admin email and password **in the terminal** and registers
   the account against Dokploy's API — no browser `/register` round-trip, no
   credentials to copy anywhere.
4. Runs Switchyard as a managed Docker container (restart policy, health
   checked end to end), bound to **127.0.0.1:3001** — the dashboard has no
   auth, so it is not exposed by default.
5. Offers to install Claude Code, and prints where everything lives.

Re-running `up` is idempotent and doubles as the upgrade path
(`npx switchyard-cli@latest up`). Settings live in a config file you change
*after* setup:

```bash
switchyard config set dashboardPort 3101   # applies by recreating the container
switchyard status                          # services, health, URLs
switchyard claude                          # launch Claude Code
```

The full command/flag/config reference — including `--headless` for
cloud-init, `--expose` (and why not to), and migration notes for existing
installs — is in [cli.md](cli.md).

## What gets deployed

| Component          | Image             | Kind            | Ports                    |
|--------------------|-------------------|-----------------|--------------------------|
| `dokploy`          | `dokploy/dokploy` | Swarm service   | **3000** (web UI + API)  |
| `dokploy-postgres` | `postgres:16`     | Swarm service   | internal only            |
| `dokploy-redis`    | `redis:7`         | Swarm service   | internal only            |
| `dokploy-traefik`  | `traefik:v3.6.7`  | plain container | **80/443** (reverse proxy) |
| `switchyard-metrics` | `postgres:16`   | Swarm service   | internal only            |
| Switchyard         | `ghcr.io/sbdeals/switchyard` (fast path) or Next.js dev server (manual) | container / node process | **3001** |

`switchyard-metrics` is the dashboard's persisted metrics store, deployed by
the CLI fast path (turn it off with `switchyard config set store false`). On
Docker Desktop, `dokploy-traefik` is skipped by default: `skipTraefik`
defaults to `true` there (see [cli.md](cli.md)).

Everything Dokploy-side attaches to the `dokploy-network` overlay network.
Credentials live in two Swarm secrets, `dokploy_postgres_password` and
`dokploy_auth_secret`.

## Prerequisites

### Linux server

- Root access — the stack scripts run under `sudo`.
- Docker Engine (`docker` CLI + `dockerd`). The scripts start the daemon
  themselves, with or without systemd.
- `curl` — fetches the upstream Dokploy installer.
- GNU `make` (optional; you can call the scripts directly).
- Node.js 20+ and `npm` — for Switchyard, and for the Claude Code CLI.
- Optional: `iproute2` (`ip`) and `jq` — the scripts degrade gracefully
  without them.

Check everything at once:

```bash
make doctor
```

### Windows 11

- Docker Desktop, running (WSL2 backend).
- Node.js 20+ and `npm`.
- Git, to clone the repo.

`make` and `bash` are **not** needed for Path B — every step is plain `docker`
plus PowerShell.

## Path A: Linux server

> The [fast path](#fast-path-one-command-all-platforms) runs this same script
> for you (plus admin registration and the dashboard container). Path A is the
> manual/contributor route.

### Bring the stack up

```bash
git clone <repo-url> dokploy-claudecode
cd dokploy-claudecode
make up
```

`make up` runs `sudo bash scripts/dokploy-up.sh`. It is idempotent — safe to
re-run when the stack is already up. It:

1. Starts `dockerd` if it isn't running (directly when there is no systemd)
   and configures the `https://mirror.gcr.io` pull-through mirror in
   `/etc/docker/daemon.json` to avoid
   [Docker Hub rate limits](troubleshooting.md#docker-hub-pull-rate-limit).
2. Refuses to install over a stale `dokploy-postgres` volume from a previous
   install — see
   [troubleshooting](troubleshooting.md#dokploy-crash-loops-on-database-auth-after-a-re-install).
3. Removes a bogus `/etc/dokploy/traefik/traefik.yml` *directory* if a failed
   install left one behind.
4. Runs the official Dokploy installer with `--endpoint-mode dnsrr` forced,
   which is required on kernels built without IPVS — see
   [troubleshooting](troubleshooting.md#service-names-resolve-but-connections-hang-no-ipvs).
5. Waits until the `dokploy` service is healthy and serving HTTP on port 3000,
   then prints status.

Configuration knobs (environment variables read by `dokploy-up.sh`):

| Variable          | Effect                                                    |
|-------------------|-----------------------------------------------------------|
| `ADVERTISE_ADDR`  | Override the auto-detected Swarm advertise IP             |
| `DOKPLOY_VERSION` | Pin a Dokploy image tag (default `latest`)                |
| `FORCE=1`         | Install even when leftover Dokploy data volumes exist     |

Pass them through `sudo`, for example
`sudo ADVERTISE_ADDR=10.0.0.5 bash scripts/dokploy-up.sh`.

### Check status

```bash
make status
```

Prints the Swarm services, the Dokploy container health, and the dashboard
URL: **http://localhost:3000** on the host, `http://<server-ip>:3000`
remotely.

### First run: create the admin

Open **http://localhost:3000** (or `http://<server-ip>:3000`). A fresh Dokploy
redirects to **`/register`** — create the admin account there. On an
internet-reachable server do this immediately after `make up`. Keep the email
and password: Switchyard signs in with them.

### Stop the stack

```bash
make down            # stop the services and Traefik; data volumes survive
make down PURGE=1    # also remove the network, secrets, and data volumes
```

`PURGE=1` removes `dokploy-network`, both secrets, and the `dokploy`,
`dokploy-postgres`, and `dokploy-redis` volumes — a genuinely fresh slate, and
the safe way to reset before a re-install.

### Optional: launch Claude Code

```bash
make claude    # requires: npm install -g @anthropic-ai/claude-code
```

## Path B: Windows 11 with Docker Desktop

> `npx switchyard-cli up` replays every step below programmatically — this
> appendix is the reference for what it does (and for doing it by hand).

The repo's native tooling does **not** run on Windows: stock Windows has no
`make.exe`, and the scripts are bash that expects root and direct control of
`dockerd`. What works instead — and what was tested on a real Windows 11
machine with Docker Desktop — is replaying the installer's core steps against
Docker Desktop's engine, as follows. macOS uses the same Docker Desktop code
path, but it has not yet been verified end-to-end there.

> **Note:** Docker Desktop's Linux VM kernel (WSL2 on Windows, LinuxKit on
> macOS) ships IPVS, so the repo's `--endpoint-mode dnsrr` workaround is *not*
> needed here and default Swarm networking works. Verified on Windows; assumed
> (not yet verified) on macOS.

> **Durability:** the Desktop VM's root filesystem — including Dokploy's
> `/etc/dokploy` tree (its Traefik config and every compose stack's working
> dir) — is rebuilt when the VM is recreated by a Docker Desktop update,
> "Reset to factory defaults", or some restarts. Containers, images, and
> **named volumes survive**; anything a stack binds under `/etc/dokploy` does
> not. `switchyard up` (and the desktop app on launch) detects stacks a reset
> broke and redeploys them from Dokploy's database, and templates deployed
> from the Switchyard dashboard put database data in named volumes for exactly
> this reason. If you deploy compose stacks by hand, prefer named volumes over
> host binds for data.

Clone the repo first (Switchyard runs from it later):

```powershell
git clone <repo-url> dokploy-claudecode
Set-Location dokploy-claudecode
```

### 1. Initialize Swarm and the network

```powershell
docker swarm init
docker network create --driver overlay --attachable dokploy-network
```

If `docker swarm init` says the node is already part of a swarm, skip it.

### 2. Create the secrets

Dokploy expects two Swarm secrets: the Postgres password and the auth secret.
Any random string works — pipe one into each:

```powershell
[guid]::NewGuid().ToString("N") | docker secret create dokploy_postgres_password -
[guid]::NewGuid().ToString("N") | docker secret create dokploy_auth_secret -
```

### 3. Pre-create /etc/dokploy inside the Docker Desktop VM

The `dokploy` service bind-mounts `/etc/dokploy` — a path inside Docker
Desktop's Linux VM, not on your Windows drive. Swarm never creates missing
bind sources, so without this step the task is **rejected** with
`invalid mount config for type "bind": bind source path does not exist: /etc/dokploy`.

Create it with a throwaway container — the `-v` flag auto-creates the path:

```powershell
docker run --rm -v /etc/dokploy:/mnt/dokploy alpine sh -c "chmod 777 /mnt/dokploy"
```

### 4. Create the three services

These mirror what `scripts/dokploy-up.sh`'s installer creates on Linux, with
one deliberate change: Dokploy is published in **ingress** mode on a free port
(3300 in the examples) instead of `mode=host` on 3000. Host-mode publishing is
not reliably forwarded to Windows `localhost`; ingress publishing works on
Docker Desktop. Pick any free port — if you change it, change every later URL
to match.

```powershell
docker service create --name dokploy-postgres `
  --constraint "node.role==manager" `
  --network dokploy-network `
  --secret dokploy_postgres_password `
  --env POSTGRES_USER=dokploy `
  --env POSTGRES_DB=dokploy `
  --env POSTGRES_PASSWORD_FILE=/run/secrets/dokploy_postgres_password `
  --mount "type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data" `
  postgres:16
```

```powershell
docker service create --name dokploy-redis `
  --constraint "node.role==manager" `
  --network dokploy-network `
  --mount "type=volume,source=dokploy-redis,target=/data" `
  redis:7
```

```powershell
$advertiseAddr = docker node inspect self --format '{{ .Status.Addr }}'
docker service create --name dokploy `
  --replicas 1 `
  --constraint "node.role==manager" `
  --network dokploy-network `
  --secret dokploy_postgres_password `
  --secret dokploy_auth_secret `
  --env ADVERTISE_ADDR=$advertiseAddr `
  --env POSTGRES_PASSWORD_FILE=/run/secrets/dokploy_postgres_password `
  --env BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret `
  --mount "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock" `
  --mount "type=bind,source=/etc/dokploy,target=/etc/dokploy" `
  --mount "type=volume,source=dokploy,target=/root/.docker" `
  --publish "published=3300,target=3000" `
  dokploy/dokploy:latest
```

Watch the services converge (the first image pulls take a while):

```powershell
docker service ls
docker service ps dokploy --no-trunc
```

You want `1/1` replicas on all three. If a `dokploy` task shows *Rejected*
with a bind-mount error, revisit step 3 — the fix is also in
[troubleshooting](troubleshooting.md#swarm-rejects-the-dokploy-task-bind-source-path-does-not-exist).

### 5. Traefik (optional)

The Linux installer also runs a `dokploy-traefik` container on ports 80/443.
For local Switchyard testing you can skip it — everything else in this guide
works without it — but **domains will not route**: attaching a domain to an
application has no effect until a Traefik proxy is running.

If ports 80/443 are already taken (common on Windows), you can still *demo*
domain routing locally over plain HTTP with the opt-in local-ingress proxy,
which runs a second Traefik on alternate ports (default 8080/8443):

```bash
switchyard local-ingress up      # http://<host>:8080 ; down to stop
```

This is **HTTP only — not real TLS**: attach the domain with certificate
"None" and HTTPS off, and point it at `127.0.0.1` in your hosts file. Real
public HTTPS domains (Let's Encrypt on 80/443) are a Linux/VPS feature — see
[cli.md](cli.md#local-ingress-demo-domain-routing) for the full rundown.

### 6. Create the admin

Open **http://localhost:3300/register** and create the admin account (first
run only). Or do it from PowerShell:

```powershell
$body = @{ name = "Admin"; email = "admin@example.com"; password = "change-me" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3300/api/auth/sign-up/email" -ContentType "application/json" -Body $body
```

Either way, keep the email and password — Switchyard signs in with them.

## Set up Switchyard (both platforms)

Switchyard is a Next.js app in [`dashboard/`](../dashboard/) that signs into
the Dokploy API server-side. See [dashboard-guide.md](dashboard-guide.md) for
what it can do once running.

> This section is the **dev-mode** setup (run from source with `npm run dev`).
> The [fast path](#fast-path-one-command-all-platforms) instead runs Switchyard
> as a preconfigured container — no `.env.local` needed. Dev mode remains the
> loop for working on the dashboard code itself.

Linux:

```bash
cd dashboard
cp .env.example .env.local
# edit .env.local (see below), then:
npm install
npm run dev      # http://localhost:3001
```

Windows:

```powershell
Set-Location dashboard
Copy-Item .env.example .env.local
notepad .env.local   # edit (see below), then:
npm install
npm run dev          # http://localhost:3001
```

`.env.local` reference:

```ini
# Dokploy API base URL.
#   Path A (Linux):                     http://localhost:3000
#   Path B (Windows, published on 3300): http://localhost:3300
DOKPLOY_URL=http://localhost:3000

# The admin account you created at /register.
DOKPLOY_EMAIL=admin@example.com
DOKPLOY_PASSWORD=change-me

# Windows only — Docker Desktop's engine named pipe. The default,
# /var/run/docker.sock, exists only on Unix hosts; without this line the
# live Logs and Metrics tabs stay empty. Omit on Linux.
DOCKER_SOCKET=//./pipe/docker_engine
```

Notes:

- The dev server binds port **3001** (`next dev -p 3001`, because Dokploy owns
  3000). If 3001 is taken, run `npx next dev -p 3002` and open that port.
- Restart `npm run dev` after changing `.env.local`.

> **Security note:** Switchyard requires signing in with a Dokploy account at
> `/login`. That login gate is not TLS, and a signed-in user holds full Dokploy
> admin (database passwords, container logs, service lifecycle) — keep it on
> localhost, or put an HTTPS proxy in front before exposing it.

## Verification checklist

Work through these in order; each has a
[troubleshooting](troubleshooting.md) entry if it fails.

1. **Services converged.** `docker service ls` shows `dokploy`,
   `dokploy-postgres`, and `dokploy-redis` at `1/1`. On Linux, `make status`
   prints "Dokploy is healthy."
2. **Dokploy answers.** Open http://localhost:3000 (Path A) or
   http://localhost:3300 (Path B): you get the Dokploy login (or `/register`
   on the first run) and can sign in as the admin.
3. **Switchyard loads.** Open http://localhost:3001: you see the workspace
   canvas (empty on a fresh install) — *not* a red "Couldn't reach Dokploy"
   card.
4. **End to end.** Create a database from Switchyard: it appears on the
   canvas, reaches a running state, and its Logs and Metrics tabs stream live
   data. On Windows this requires the `DOCKER_SOCKET` line above.

## Next steps

- [dashboard-guide.md](dashboard-guide.md) — a tour of Switchyard's features.
- [architecture.md](architecture.md) — how Switchyard, Dokploy, and Docker fit
  together.
- [launch-tooling.md](launch-tooling.md) — the `make` targets and `scripts/`
  in depth.
- [troubleshooting.md](troubleshooting.md) — when something breaks.
