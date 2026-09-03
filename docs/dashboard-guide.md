# Switchyard dashboard guide

Switchyard is the Railway-style dashboard in [`dashboard/`](../dashboard/) that drives a [Dokploy](https://dokploy.com) install. Everything Dokploy can run — applications, managed databases, docker-compose stacks — appears as a node on one canvas, and each service gets a drawer with its configuration, lifecycle controls, live logs, and live metrics.

This guide tours the features. To install the stack and connect Switchyard to it (admin credentials, `.env.local`, ports), follow [getting-started.md](getting-started.md) first; for how it all works internally, see [architecture.md](architecture.md); when something breaks, see [troubleshooting.md](troubleshooting.md).

> **Login required — but a login is not TLS.** Switchyard gates every page, action, and log/metric stream behind a per-user Dokploy login (`/login`). A signed-in user still holds full Dokploy admin (create/destroy services, read database passwords, stream logs) and traffic is plain HTTP — keep it on localhost (the default) or put an HTTPS proxy in front before exposing it. See the [security note in getting-started](getting-started.md#set-up-switchyard-both-platforms) and the security model in [architecture.md](architecture.md).

The screenshots come from a live local deployment with two demo services: `redis-mskd`, a Redis database created with one click, and `whoami-snim`, an application deployed from the `traefik/whoami` Docker image.

## The workspace

Open http://localhost:3001. The header reads **Services** ("Apps and databases across your Dokploy projects") and carries four controls on the right: a **Canvas | Grid** view toggle, **Projects**, **Refresh**, and the purple **New service** button. On a fresh install the workspace shows a "No services yet" placeholder with a New service button; once you have services, the canvas is the default view.

![Canvas view: the whoami-snim application node and the redis-mskd database node under the "My Project / production" label, joined by an inferred edge, with minimap and zoom controls](images/canvas-overview.png)

### Canvas view

Each service is a draggable card: an icon and accent color per kind (purple box for applications, engine-colored database icon for databases, teal layers for compose stacks), the service name, a subtitle with its Docker image or kind, and a status dot on the right. Services are grouped by project and environment — the uppercase label ("MY PROJECT / PRODUCTION" above) marks each group's column.

The animated dashed line from `whoami-snim` to `redis-mskd` is an inferred connection: the app's environment variables reference the Redis service, so Switchyard draws an arrow from the consumer to its dependency. [How canvas connections work](#how-canvas-connections-work) explains the heuristic.

- Click a node to open its drawer.
- Drag nodes to arrange them; positions are remembered in your browser's localStorage (not on the server), so the layout is per-browser.
- Zoom controls sit bottom-left; the minimap bottom-right pans and zooms the viewport.

### Grid view

Click **Grid** in the header toggle for a flat card list — handy once the canvas gets busy or on narrow windows.

![Grid view: redis-mskd and whoami-snim cards, each with a Running badge and its "My Project / production" scope](images/grid-view.png)

Each card shows the same identity, status badge, and project/environment scope; click a card to open the drawer. Services that have never been deployed show a one-click **Deploy** button directly on the card.

### Projects and environments

Dokploy organizes services under **project → environment** (for example `My Project / production`). Click **Projects** in the header to manage that tree.

![Projects & environments panel: My Project with its production environment, rename and delete icons, a "new environment" input with Add env, and the new-project input](images/projects-view.png)

- Create a project with the **new project name** input at the bottom.
- Add an environment to a project with its inline **new environment** input and **Add env**.
- The pencil icon renames a project or environment (a browser prompt asks for the new name); the trash icon deletes it after a confirmation. Deleting a project deletes everything in it.

You don't have to set this up before deploying: if no project exists, the first quick deploy creates "My Project" with a default environment automatically. When more than one environment exists, the New service menu grows a selector at the top so you can pick where the service lands.

### Statuses and refresh

Every badge and canvas dot uses the same states:

| Badge | Meaning |
|---|---|
| Idle (gray) | Created but not deployed — nothing is running yet |
| Deploying (amber, pulsing) | A deployment is in progress |
| Running (green) | Deployed and up |
| Error (red) | The last operation failed |

The page renders from live Dokploy state on every load, and every action (deploy, save, destroy) refreshes it — but statuses do **not** poll in the background. If a deployment finishes while you're just looking at the canvas, click **Refresh** to see the badge flip. The Logs and Metrics tabs are the genuinely live parts. If instead of the workspace you see a red "Couldn't reach Dokploy" card, Switchyard can't talk to the Dokploy API — see [troubleshooting](troubleshooting.md#switchyard-shows-the-couldnt-reach-dokploy-card).

## Creating services

Click **New service** to open the creation menu. Everything here is one click (or one field) away from a deployed service; all details are editable afterward in the drawer.

![New service menu: Application section with docker image input, git repo input and Compose stack row; Database section listing PostgreSQL, MySQL, MariaDB, MongoDB and Redis with version tags](images/new-service-menu.png)

The **Application** section offers three ways in: deploy from a Docker image, deploy from a Git repository, or create a Compose stack. The **Database** section lists the five managed engines with the exact image each would deploy: `postgres:18`, `mysql:8.4`, `mariadb:11`, `mongo:8`, `redis:7`.

### One-click databases

Click an engine row and Switchyard provisions and deploys a database immediately — no form. It auto-generates:

- a friendly name: the engine plus a random suffix (that's where `redis-mskd` came from),
- a random 20-character password,
- the newest curated version of the engine (the tag shown in the menu).

For PostgreSQL, MySQL, and MariaDB the user defaults to `admin` and the database name to the service name; MongoDB gets a user but no database name; Redis takes neither. The menu closes and the new database's drawer opens so you can watch it come up. Version, name, ports, and resource limits can all be changed later in [Settings](#settings-and-the-danger-zone).

### Deploy from a Docker image

Type any public image reference into the **docker image** field — `nginx:alpine`, `traefik/whoami`, `ghcr.io/org/app:tag` — and click **Deploy** (or press Enter).

![New service menu with the docker image field filled in with traefik/whoami and the Deploy button enabled](images/deploy-image-filled.png)

Switchyard creates an application named after the image plus a random suffix (`traefik/whoami` became `whoami-snim`), points it at the image, and deploys it. The drawer opens on the new service. There are no registry-credential fields in this menu, so the image must be publicly pullable.

### Deploy from a Git repository

Paste a public clone URL (for example `https://github.com/you/my-app.git`) into the **git repo url** field and click **Deploy**. Switchyard creates an application named after the repository, sets it to build from the `main` branch at the repo root with **Nixpacks** (Dokploy's default buildpack — it detects the language and produces an image without a Dockerfile), and starts the first deployment.

No OAuth or deploy keys are involved — the URL is cloned directly, so the repository must be public. Builds take longer than image deploys; the service shows **Deploying** while Nixpacks works, and the [Deploys tab](#deployment-history) records the attempt. Branch and build path are editable in Dokploy itself if you need something other than `main` at `/`.

### Compose stacks

Click **Compose stack** and Switchyard immediately creates the service — again, no form. It appears on the canvas as **Idle** (nothing is running yet) and its drawer opens. On the **Compose** tab you'll find the editor seeded with a starter `docker-compose.yml`:

![Compose stack drawer for compose-sgzh in Idle state, showing the Compose tab's YAML editor with the nginx:alpine starter template and the Save and Save & deploy buttons](images/compose-editor.png)

The starter file runs nginx and publishes it on port 8080:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - 8080:80
```

Replace it with your own stack, then click **Save & deploy** to store the file and deploy it in one step (**Save** stores it without deploying). Until you deploy, the stack stays Idle — if you close the drawer without saving, the idle service still exists and can be deployed or destroyed later. Compose stacks have no Variables tab; define environment variables inside the YAML.

## Working with a service

Click any node or card to slide in the service drawer from the right. The header shows the service's icon, name, status badge, and its kind and scope (for example "Docker image · My Project / production"). Close it with the X or by clicking the dimmed canvas.

The tab row depends on the service kind:

| Kind | Tabs |
|---|---|
| Application | Overview · Variables · Domains · Deploys · Metrics · Logs · Settings |
| Database | Overview · Variables · Metrics · Logs · Settings |
| Compose stack | Overview · Compose · Logs · Settings |

There is no separate "Source" tab — an application's source (Docker image or Git repository) is shown on its Overview tab.

### Overview and lifecycle

Every Overview starts with the lifecycle buttons for the service's current state (see the [lifecycle reference](#lifecycle-reference)) followed by the service's key facts. For an application:

![whoami-snim application drawer, Overview tab: Stop and Redeploy buttons, Public URL empty state, and Source, Image, Build, and Replicas fields](images/app-overview.png)

- **Public URL** — the first attached domain, as a clickable link; before you attach one it reads "No domain yet — add one in the Domains tab."
- **Source** — where the app comes from (`docker` for image deploys, the Git provider for repo deploys), with the **Image** or **Repository** next to it.
- **Build** — Dokploy's build type. It defaults to `nixpacks`, which is what actually builds Git deploys; for image-based apps the field is informational only.
- **Replicas** — how many task instances run.

A database Overview shows the connection string (next section) plus image, internal port, replicas, database/user names, and resource limits. A compose Overview is minimal — its type and app name and a pointer to the Compose tab.

### Database connection strings

Open a database's Overview to grab its connection string, ready to paste into another service's variables:

![redis-mskd database drawer, Overview tab: Running badge, Stop and Redeploy buttons, internal connection string with copy button, and Image, Internal port, Replicas, Database, User, and Resources fields](images/db-overview.png)

> **About the visible password:** the credential in this and later screenshots is a locally generated throwaway from the demo machine, gone along with it — not a leaked secret. Yours will be different (and worth protecting).

The string is the **internal** address: its host is the service's *app name* (the long generated identifier shown in Settings, `redis-input-open-source-driver-…` here) and its port is the engine's default port. That name resolves only on the Dokploy overlay network, so the string works from other services deployed on the same stack — it will not work from your laptop. To reach a database from outside, set an **External port** in Settings instead, which publishes the engine's port on the host.

The format per engine:

| Engine | Internal connection string |
|---|---|
| PostgreSQL | `postgresql://user:password@app-name:5432/database` |
| MySQL / MariaDB | `mysql://user:password@app-name:3306/database` |
| MongoDB | `mongodb://user:password@app-name:27017` |
| Redis | `redis://default:password@app-name:6379` |

The copy button at the end of the field copies the full string.

### Environment variables

The **Variables** tab (applications and databases) is a plain-text editor: one `KEY=value` per line, with `#` lines treated as comments. The counter under the editor tallies the real variables, and **Save variables** stays disabled until you change something. As the hint says, redeploy the service for changes to take effect.

![whoami-snim Variables tab: a REDIS_URL entry pointing at the redis-mskd internal connection string, with the 1 variable counter and Save variables button](images/app-variables.png)

Here `whoami-snim` carries one variable, `REDIS_URL`, set to `redis-mskd`'s internal connection string. This is also what draws the canvas edge between the two services — the variable's value contains the Redis service's app name, so Switchyard infers the dependency.

### Domains

The **Domains** tab (applications only) attaches public hostnames. Enter the **Host** (for example `app.example.com`), the container **Port** your app listens on (default 80), and click **Add**. Certificates are automatic — domains are created with HTTPS and Let's Encrypt.

![whoami-snim Domains tab: the auto-SSL hint, the "No domains attached." empty state, and the Host, Port and Add form](images/app-domains.png)

Two prerequisites, both outside Switchyard:

- **DNS** — point the domain's records at the server, as the tab's hint says.
- **Traefik** — routing is done by the Dokploy stack's Traefik proxy. The Linux installer (getting-started Path A) runs it automatically; on the Windows path it's an [optional step](getting-started.md#5-traefik-optional), and without it attached domains simply won't route.

Attached domains appear as clickable rows above the form, and the first one becomes the Public URL on the Overview tab.

**Auto-URL.** On the Linux path you usually don't add anything here: deploying an app mints a public URL automatically (a Dokploy `*.traefik.me` host, or `<app-name>.<server-ip>.sslip.io` — both resolve to the server with no DNS to configure) and it shows up as the Public URL on the Overview tab. It routes to container port `3000` by default; if your app listens on a different port, add a domain here with the right port. Auto-URL is **off on Docker Desktop and in dev mode** — there the Dokploy Traefik proxy isn't managed, so nothing would route, and you add domains by hand as above.

### Deployment history

The **Deploys** tab (applications only) lists every deployment, newest first. Each row shows a status dot (green done, red error, amber in progress), the deployment title, its timestamp, and the status as text — so after a few redeploys you can see at a glance when the app last shipped cleanly and whether anything failed. A never-deployed app shows "No deployments yet."

The tab also carries the **push-to-deploy** controls for git-sourced apps: the branch, an auto-deploy toggle, watch paths, and the app's copyable Dokploy webhook URL — add it as a push webhook on your Git host and every push to the configured branch redeploys. Rows whose deployment produced a registry image snapshot show a **Roll back** button (Dokploy records these only when the app deploys to a registry with rollbacks enabled).

Per-deployment build logs aren't viewable in Switchyard yet (it's on the [dashboard roadmap](../dashboard/README.md#status)). To follow a deploy as it happens, watch the status badge and switch to Logs once the container starts.

### Live logs

Every kind has a **Logs** tab that streams the service's container output live — no page reloads. It opens with the last 300 lines and then follows:

![redis-mskd Logs tab streaming timestamped Redis startup lines, with the filter box and the green Live indicator](images/db-logs.png)

- The green **Live** dot confirms the stream is connected.
- Each line is prefixed with its timestamp in your local time.
- **Filter logs…** narrows the view to lines containing your text (case-insensitive, applied live).
- The view sticks to the bottom as lines arrive; scroll up to pause following, scroll back down to resume. The buffer is capped at a couple thousand lines, so very chatty services roll off the top.

If the service isn't running you'll get a placeholder line instead of a stream. On Windows, empty Logs and Metrics tabs usually mean the Docker socket isn't configured — see [troubleshooting](troubleshooting.md#logs-and-metrics-tabs-are-empty-on-windows).

### Live metrics

The **Metrics** tab samples the container's CPU and memory roughly once a second while the tab is open:

![redis-mskd Metrics tab: CPU 0.3% and Memory 4 MB stat cards above live CPU % and Memory area charts](images/db-metrics.png)

The two cards show the latest sample — CPU percentage, and memory used "of" the container's limit (when no limit is set, Docker reports the host's total, as in the screenshot). Below them, area charts keep the last 60 samples (about a minute); hover for exact values. Sampling starts when you open the tab, so the charts fill from the left. A stopped service shows "No metrics — the service isn't running."

### Settings and the danger zone

The **Settings** tab holds everything editable plus the destructive actions. For a database:

![redis-mskd Settings tab: name field, version selector, external port, CPU and memory limits with Save changes, masked password with reveal and copy, app name, created date, and the Danger zone](images/db-settings.png)

- **Name** — rename the service (display name only; the app name is fixed).
- **Version** — a dropdown of curated tags per engine (PostgreSQL 18/17/16/15, MySQL 8.4/8.0, MariaDB 11/10, MongoDB 8/7/6, Redis 7/6). As the hint warns, changing it redeploys.
- **External port** — publish the database on the host to reach it from outside the stack; "blank = internal only".
- **CPU limit / Memory limit** — Docker-format strings, e.g. `0.5` CPUs and `256m` of memory; blank means unlimited.
- **Save changes** applies the edits; version, port, and resource changes are pushed to the running container.
- **Password** — masked by default, with reveal and copy buttons (rotation is "coming soon").
- **App name** and **Created** — the generated Swarm identity (the hostname other services use) and the creation timestamp.

Application Settings offer name and CPU/memory limits (saving a resource change triggers a redeploy) plus the app name; compose Settings show only the app name and creation date.

Every Settings tab ends in the red **Danger zone**: a **Destroy** button that removes the service and its container(s) — for compose stacks, the whole stack and all its containers. A browser confirmation stands between you and the click, but there is no undo.

## How canvas connections work

Dokploy has no native "connect these services" concept, so Switchyard infers the arrows from environment variables: if service A's variables mention service B's app name (or its display name), an edge is drawn **from A to B** — from the consumer to the thing it depends on. That's why `whoami-snim → redis-mskd` appears in the hero screenshot: whoami's `REDIS_URL` contains the Redis service's app name. Edges animate and take the color of the service they point at.

Practical consequences:

- **To create an edge**, put a real reference in the consumer's Variables — pasting a database's internal connection string is the canonical way.
- **To remove one**, delete the referencing variable and refresh.
- **False positives happen.** The match is a plain substring check, so if one service's name happens to appear inside an unrelated variable value — or inside another service's name — you may get an arrow that means nothing. Cosmetic only; it changes no behavior.

## Lifecycle reference

All three kinds share the same verbs. The buttons on Overview change with the current status; Destroy always lives in Settings.

| Verb | Where | What it does |
|---|---|---|
| Deploy | Overview (when Idle), or the card in grid view | First deployment: pull/build and start |
| Redeploy | Overview (any deployed state) | Re-run the deployment — pick up new images, variables, or compose edits |
| Stop | Overview (when Running) | Stop the container; configuration and data volumes stay |
| Start | Overview (after a stop, failed deploy, or while one is in flight) | Start it again without a full redeploy |
| Destroy | Settings → Danger zone | Remove the service and its container(s), after a confirmation — irreversible |

By status: **Idle** shows Deploy; **Running** shows Stop and Redeploy; **Deploying** and **Error** show Start and Redeploy.

## Tips and limits

- **Login required, but no TLS.** Worth repeating: anyone who signs in at `/login` is a full Dokploy admin, and the dashboard speaks plain HTTP. Keep it local (the default) or put an HTTPS proxy in front ([details](getting-started.md#set-up-switchyard-both-platforms)).
- **Canvas layout is per-browser.** Node positions live in your browser's localStorage — another browser or machine sees the default column layout, and clearing site data resets yours.
- **Edges are a heuristic.** Substring matching over env vars catches the common cases and occasionally invents an arrow; treat the canvas lines as hints, not truth.
- **Statuses don't auto-refresh.** Click **Refresh** to see a background deployment finish; only Logs and Metrics stream live.
- **Public sources only.** The New service menu takes public Docker images and public Git URLs; there are no fields for registry credentials or deploy keys.
- **Not there yet** (per the [dashboard roadmap](../dashboard/README.md#status)): per-deployment build logs and database password rotation. (Backups and dashboard auth shipped — see the Backups tab and `/login`.)
