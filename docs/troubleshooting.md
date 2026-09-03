# Troubleshooting

Symptom → cause → fix reference for the Dokploy stack and the Switchyard
dashboard. Install steps live in [getting-started.md](getting-started.md);
background on the launch scripts is in [launch-tooling.md](launch-tooling.md)
and on the dashboard in [architecture.md](architecture.md).

## Contents

1. [Swarm rejects the Dokploy task: bind source path does not exist](#swarm-rejects-the-dokploy-task-bind-source-path-does-not-exist) *(Docker Desktop)*
2. [Ports 80, 443, 3000 or 3001 are already in use](#ports-80-443-3000-or-3001-are-already-in-use)
3. [Dokploy crash-loops on database auth after a re-install](#dokploy-crash-loops-on-database-auth-after-a-re-install) *(Linux)*
4. [Traefik crash-loops: traefik.yml is a directory](#traefik-crash-loops-traefikyml-is-a-directory) *(Linux)*
5. [Service names resolve but connections hang (no IPVS)](#service-names-resolve-but-connections-hang-no-ipvs) *(some Linux hosts)*
6. [Docker Hub pull rate limit](#docker-hub-pull-rate-limit)
7. [Switchyard shows the "Couldn't reach Dokploy" card](#switchyard-shows-the-couldnt-reach-dokploy-card)
8. [Logs and Metrics tabs are empty on Windows](#logs-and-metrics-tabs-are-empty-on-windows)
9. [switchyard up can't pull the dashboard image](#switchyard-up-cant-pull-the-dashboard-image)
10. [Dashboard container can't talk to Dokploy (deep health check fails)](#dashboard-container-cant-talk-to-dokploy-deep-health-check-fails)
11. [make is not found on Windows](#make-is-not-found-on-windows)
12. [Still stuck](#still-stuck)

## Swarm rejects the Dokploy task: bind source path does not exist

**Symptom.** On Docker Desktop, the `dokploy` service never starts.
`docker service ps dokploy --no-trunc` shows every task *Rejected* with:

```text
invalid mount config for type "bind": bind source path does not exist: /etc/dokploy
```

**Cause.** The service bind-mounts `/etc/dokploy`, and Swarm — unlike
`docker run` — never creates a missing bind source. The path has to exist
inside Docker Desktop's Linux VM (not on your Windows drive), and nothing
creates it for you there; on a Linux server the installer takes care of it.

**Fix.** Create the directory inside the VM with a throwaway container — the
`-v` flag auto-creates the path — then watch Swarm retry:

```powershell
docker run --rm -v /etc/dokploy:/mnt/dokploy alpine sh -c "chmod 777 /mnt/dokploy"
docker service ps dokploy
```

Swarm keeps rescheduling rejected tasks, so the service normally recovers on
its own within a minute. If it doesn't:

```powershell
docker service update --force dokploy
```

## Ports 80, 443, 3000 or 3001 are already in use

**Symptom.** The Linux installer aborts complaining that a port is in use; or
`docker service create` / Traefik fails to publish a port; or the Switchyard
dev server can't bind 3001.

Who wants what: **3000** Dokploy UI/API, **80/443** Traefik, **3001**
Switchyard dev server.

**Cause.** On dev machines, other stacks commonly squat these ports.

**Fix.** First find the owner.

Linux:

```bash
sudo ss -ltnp | grep -E ':(80|443|3000|3001)\b'
```

Windows:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 80, 443, 3000, 3001, 3300 -ErrorAction SilentlyContinue
Get-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 3000).OwningProcess
```

Then either stop the squatter, or move this stack around it:

- **Republish Dokploy on another port** (example: move the ingress mapping
  from 3300 to 3301):

  ```powershell
  docker service update --publish-rm "published=3300,target=3000" --publish-add "published=3301,target=3000" dokploy
  ```

- **Run Switchyard on another port:**

  ```bash
  npx next dev -p 3002
  ```

- **Point Switchyard at the new Dokploy port:** update `DOKPLOY_URL` in
  `dashboard/.env.local` and restart the dev server.

## Dokploy crash-loops on database auth after a re-install

**Symptom.** After a tear-down/re-install cycle, `make up` refuses with:

```text
Found a dokploy-postgres volume from a previous install. Its password will not
match the fresh install's secrets. Either wipe the old data first
(scripts/dokploy-down.sh --purge) or re-run with FORCE=1 to install anyway.
```

Or — if the install went ahead anyway — the `dokploy` service restart-loops
and `docker service logs dokploy` is full of Postgres authentication
failures.

**Cause.** The upstream installer runs `docker swarm leave --force`, which
destroys the Swarm *secrets* (including the generated Postgres password),
while Docker *volumes* survive. A leftover `dokploy-postgres` volume still
holds the old password; the fresh install generates a new secret that no
longer matches, so Dokploy can't sign into its own database.
`scripts/dokploy-up.sh` detects the stale volume and refuses before you walk
into this.

**Fix.** Wipe the old data (this destroys all Dokploy state), then install:

```bash
sudo bash scripts/dokploy-down.sh --purge    # or: make down PURGE=1
make up
```

Only if you deliberately want to keep the old volume:

```bash
sudo FORCE=1 bash scripts/dokploy-up.sh
```

## Traefik crash-loops: traefik.yml is a directory

**Symptom.** The `dokploy-traefik` container restart-loops and
`docker logs dokploy-traefik` shows it failing to read its configuration. On
the host, the config "file" turns out to be a directory:

```bash
ls -ld /etc/dokploy/traefik/traefik.yml    # drwxr-xr-x ... (a directory)
```

**Cause.** The Traefik container was created — bind-mounting
`/etc/dokploy/traefik/traefik.yml` — before the Dokploy app had written that
file. For plain containers Docker auto-creates a missing bind source *as a
directory*, so the config path became an empty directory Traefik can never
read, and the app can no longer write the real file in its place.

**Fix.** Remove the bogus directory so the app can write the real file, then
restart Traefik:

```bash
sudo rm -rf /etc/dokploy/traefik/traefik.yml
docker restart dokploy-traefik
```

If the file does not reappear, force-restart the Dokploy app so it rewrites
its Traefik config, then restart Traefik again:

```bash
docker service update --force dokploy
docker restart dokploy-traefik
```

`scripts/dokploy-up.sh` also removes the bogus directory automatically before
any fresh install.

## Service names resolve but connections hang (no IPVS)

**Symptom.** Swarm services can resolve each other's names (DNS returns an
IP) but TCP connections to those names hang or time out — for example Dokploy
can't reach `dokploy-postgres` even though both services run. Seen on
minimal or sandboxed kernels.

**Check** whether the kernel has IPVS (`make doctor` prints the same):

```bash
zcat /proc/config.gz | grep CONFIG_IP_VS
```

`# CONFIG_IP_VS is not set` means this entry applies.

**Cause.** Swarm's default endpoint mode gives every service a virtual IP
that is load-balanced by IPVS. Without IPVS in the kernel, the VIP routes
nothing: DNS works, packets go nowhere.

**Fix.** Run every service that others dial by name with
`--endpoint-mode dnsrr`, which resolves service names straight to task IPs
and bypasses IPVS. The repo's scripts already force this for the whole
Dokploy stack by running the installer with `container=lxc` (the upstream
installer's Proxmox-LXC code path uses dnsrr). Apply it to services you add
yourself:

```bash
docker service create --endpoint-mode dnsrr --network dokploy-network <image> ...
```

Docker Desktop is unaffected — its Linux VM kernel (WSL2 on Windows, LinuxKit
on macOS) ships IPVS, so the default VIP mode works there (verified on
Windows; assumed on macOS).

## Docker Hub pull rate limit

**Symptom.** Image pulls fail — during install or when tasks start — with:

```text
toomanyrequests: You have reached your pull rate limit.
```

**Cause.** Docker Hub meters anonymous pulls per source IP. On shared egress
IPs (cloud sandboxes, CI runners, corporate NAT) the quota is often already
exhausted by other tenants.

**Fix.** Pull through Google's mirror. On Linux hosts `make up` configures it
automatically (`scripts/lib.sh`, `ensure_registry_mirror`). To do it by hand,
merge this into `/etc/docker/daemon.json` and restart the daemon:

```json
{
  "registry-mirrors": ["https://mirror.gcr.io"]
}
```

On Docker Desktop: Settings → Docker Engine, add the same key to the JSON,
then Apply & restart.

## Switchyard shows the "Couldn't reach Dokploy" card

**Symptom.** Instead of the workspace, http://localhost:3001 renders a red
card titled **"Couldn't reach Dokploy"** with an error message underneath.

**Cause.** Switchyard's server side could not reach the Dokploy API at
`DOKPLOY_URL` (from `dashboard/.env.local` in dev mode, or the container env
set by the CLI) with the signed-in user's session. A rejected or expired
session never shows this card: it redirects to `/login` instead. The card
(rendered by `dashboard/src/app/page.tsx`) prints the underlying error
verbatim: read it first, since it names the URL it tried and whether Dokploy
answered at all. `DOKPLOY_EMAIL` / `DOKPLOY_PASSWORD` do not affect this page;
they only power the deep health probe and the background metrics collector.

**Fix.** For the CLI-managed container, see
[Dashboard container can't talk to Dokploy](#dashboard-container-cant-talk-to-dokploy-deep-health-check-fails).
For dev mode, this checklist:

1. **Is Dokploy up?** `make status` (Linux) or `docker service ls` — the
   `dokploy` service must be `1/1`, and its URL must answer in a browser.
2. **Is `DOKPLOY_URL` right?** Default `http://localhost:3000`; if you
   published Dokploy on another port (e.g. 3300 on the Windows path), it must
   say so — host *and* port.
3. **Is your session still good?** Sign out and back in at `/login` with your
   Dokploy account. If Dokploy itself rejects that sign-in, fix the account in
   the Dokploy UI first.
4. **Restart the dev server** after any `.env.local` change.

## Logs and Metrics tabs are empty on Windows

**Symptom.** In Switchyard on Windows, a service's **Logs** and **Metrics**
tabs never show data, while everything else works.

**Cause.** Switchyard streams logs and stats straight from the Docker Engine
API. The socket path defaults to `/var/run/docker.sock`
(`dashboard/src/lib/docker.ts`), which only exists on Unix hosts — on Windows,
Docker Desktop's engine listens on a named pipe instead.

**Fix.** Add the named pipe to `dashboard/.env.local` and restart the dev
server:

```ini
DOCKER_SOCKET=//./pipe/docker_engine
```

## switchyard up can't pull the dashboard image

**Symptom.** `switchyard up` fails at the container step with
`Could not pull ghcr.io/sbdeals/switchyard:<tag> and no local copy exists`.

**Cause.** Either no release with that tag has been published to GHCR yet
(the CLI defaults its image tag to its own version), or the host can't reach
ghcr.io.

**Fix.** Point at a published tag, or build the image locally from a repo
checkout:

```bash
switchyard up --tag latest
# or:
docker build -t ghcr.io/sbdeals/switchyard:dev dashboard/
switchyard config set imageTag dev
```

## Dashboard container can't talk to Dokploy (deep health check fails)

**Symptom.** `switchyard up` reports the dashboard running but failing the
`/api/health?deep=1` probe — with either a credentials or a network message.

**Cause & fix, by message:**

- **Credentials** (`sign-in failed`, 401/403): the stored admin credentials no
  longer match Dokploy (password changed, database restored). Update them:

  ```bash
  switchyard config set adminEmail you@example.com
  switchyard config set adminPassword <current-password>
  ```

- **Network** (timeouts, DNS errors): the container reaches Dokploy at
  `http://dokploy:3000` over `dokploy-network` by default. If service DNS
  doesn't resolve in your setup, go through the host instead:

  ```bash
  switchyard config set dokployUrlInContainer http://host.docker.internal:<dokploy-port>
  ```

  On a Linux host without `host.docker.internal`, use the host's LAN or
  advertise IP.

## make is not found on Windows

**Symptom.** In PowerShell, `make up` fails because `make` is not recognized
as a command; running the scripts with Git Bash fails too (they require root
and try to manage `dockerd` directly).

**Cause.** The repo's native path targets a Linux host. Stock Windows has no
`make.exe`, and the bash scripts assume root plus direct control of the
Docker daemon. Running them natively on Windows is not supported.

**Fix.** Either of:

- Follow
  [Path B in getting started](getting-started.md#path-b-windows-11-with-docker-desktop) —
  plain `docker` commands against Docker Desktop, no `make` or bash needed.
- Run the Linux path unchanged inside a WSL2 distro.

## Still stuck

Ask Docker what actually happened. Task-level failures (mount rejections,
pull errors, scheduling) show up here, with full messages:

```bash
docker service ps dokploy --no-trunc
```

Application output:

```bash
docker service logs dokploy
docker service logs dokploy-postgres
docker logs dokploy-traefik     # Traefik is a plain container, not a service
```

Substitute any service name; the same commands work verbatim in PowerShell on
Docker Desktop. For the reasoning behind each workaround the launch scripts
apply, see [launch-tooling.md](launch-tooling.md); for how the dashboard talks
to Dokploy and Docker, see [architecture.md](architecture.md).
