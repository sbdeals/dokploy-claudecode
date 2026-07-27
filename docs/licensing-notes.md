# Licensing notes: building on Dokploy

Switchyard consumes Dokploy in the lightest-touch way possible: it drives
Dokploy's HTTP API from its own, independently written clients
(`dashboard/src/lib/dokploy.ts`, `mcp/src/dokploy.ts`) and has the **user's
own Docker** pull the official `dokploy/dokploy` image from Docker Hub —
exactly like Dokploy's own install script. No Dokploy code is vendored,
forked, or redistributed here.

Dokploy is dual-licensed:

- **Apache 2.0** for everything outside its `/proprietary` folder — commercial
  use, modification, and building on top are explicitly permitted.
- **Dokploy Source Available License (DSAL)** for the `/proprietary` folder:
  those enterprise features may not be used in production without a
  commercial agreement with Dokploy.

That structure poses no problem for what Switchyard does today. Two things
are worth re-checking over time.

## 1. The `/proprietary` (DSAL) boundary

Production use of Dokploy's DSAL-licensed features requires a commercial
agreement with Dokploy, so Switchyard must stay clear of that folder's
surface area:

- Don't market, bundle, or resell DSAL-licensed features as Switchyard
  features.
- Don't ship a hosted offering ("Switchyard Cloud" or similar) that runs
  Dokploy's proprietary components in production without an agreement.
- **On every supported-Dokploy version bump**, skim the upstream
  `/proprietary` folder: if a capability Switchyard drives through the API
  (backups, notifications, …) migrates into it, that integration needs a
  second look before the bump ships.

## 2. Version pinning and API/license drift

The stack currently deploys `dokploy/dokploy:latest`, so upstream API changes
— or a change in Dokploy's licensing posture — land here immediately and
untested. When touching the launch tooling, weigh pinning a known-good
Dokploy version and reviewing upstream release notes (including license-file
diffs) as part of the upgrade routine. This is as much an engineering
exposure as a legal one.

## Trademarks

"Dokploy" and "Railway" are trademarks of their respective owners, used in
this project only nominatively — to say what Switchyard builds on and what
its UI style is comparable to. Switchyard is an independent project, not
affiliated with, sponsored by, or endorsed by Dokploy or Railway Corp. Keep
it that way: neither name belongs in the project's name, domains, npm
keywords, or logo, and none of their logos or UI assets may be copied into
this repo.
