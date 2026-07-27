# Switchyard Desktop

The one-click app: double-click, and the window becomes your Switchyard
dashboard with the whole Dokploy stack running underneath. This package is a
GUI shell around the CLI's converge logic — it imports `cli/src/core/*` and
`cli/src/platform/docker-desktop.ts` directly, so the CLI stays the single
source of truth for HOW the stack is provisioned.

## What it does on launch

1. **Prereq wizard** (first run only): if Docker Desktop is missing, it
   downloads the official installer and runs it — elevated on Windows
   (`install --accept-license` after the user accepts in our UI), silent
   attach+copy on macOS with a Finder fallback. Handles the reboot-required
   (3010) case.
2. **Engine**: starts Docker Desktop if installed but not running, and polls
   `docker info` until the daemon answers.
3. **Converge**: the same flow as `switchyard up` headless — port
   adoption/auto-bump, generated admin credentials, `ensureDokploy`,
   `ensureSwitchyard`, deep health check. Progress streams into the status
   view; failures become friendly error cards (including the stale-volume trap,
   which offers "keep data" (`--force`) vs "fresh start" (purge)).
4. **Auto-login**: mints the dashboard's `switchyard_session` cookie itself
   (it knows the admin credentials and the session secret from config.json)
   and injects it into Electron's cookie jar — the window opens straight into
   the workspace. Mirror of `dashboard/src/lib/session.ts`; keep in sync.
5. **Tray**: open dashboard/Dokploy, start/stop/restart the stack, reset
   everything (purge + reinstall), start-at-login toggle, update check, quit
   (the stack keeps running — containers are `restart unless-stopped`).

Auto-update: `electron-updater` against GitHub Releases (`latest.yml` is
published by the release workflow). Windows works unsigned; macOS auto-update
works on release builds, which are signed and notarized in CI (see
[Releasing](#releasing) — unsigned mac builds, e.g. local `npm run dist`, are
rejected by Squirrel.Mac and fall back to the tray's manual update check).

## Dev

```bash
cd desktop
npm install
npm run typecheck
npm start          # build + launch the app
npm run smoke      # headless end-to-end: converge + auto-login proof (exit 0 = pass)
npm run dist       # build the installer locally (no publish)
```

Useful env vars: `SWITCHYARD_DESKTOP_SMOKE=1` (windowless smoke mode),
`SWITCHYARD_DISABLE_GPU=1` / `--gpu-safe` (software rendering — applied
automatically after repeated GPU-process crashes),
`SWITCHYARD_CONFIG` (alternate config path, honored by the cli core).

`scripts/gen-icon.mjs` generates all icons at build time (pure Node, no image
deps). `scripts/ui-shot-main.cjs` renders each status-view state offscreen to
PNGs for docs/design review: `npx electron scripts/ui-shot-main.cjs`.

## Releasing

Tag `vX.Y.Z` (must equal `cli/package.json` AND `desktop/package.json`
versions — CI enforces both). The release workflow builds NSIS + DMG/zip on
Windows/macOS runners and uploads them with the auto-update feed to the
GitHub release.

### macOS signing & notarization

The macOS leg signs (Developer ID + hardened runtime, entitlements in
`build/entitlements.mac.plist`) and notarizes when the repo secrets below are
set. **All five are optional as a group**: if they're absent (forks, or before
the certs exist), electron-builder logs a warning, skips signing and
notarization, and still produces a working unsigned build — but macOS
auto-update only works on signed builds.

| Repo secret | What it is |
| --- | --- |
| `CSC_LINK` | Base64 of the Developer ID Application cert as a `.p12` |
| `CSC_KEY_PASSWORD` | Password chosen when exporting that `.p12` |
| `APPLE_ID` | Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-character Team ID |

One-time setup (needs a paid Apple Developer Program membership):

1. **Certificate**: in [developer.apple.com](https://developer.apple.com) →
   Certificates, create a **Developer ID Application** certificate (generate a
   CSR via Keychain Access → Certificate Assistant). Download it, import it
   into Keychain Access, then export the certificate **with its private key**
   as a `.p12` (choose an export password → `CSC_KEY_PASSWORD`). Encode it:
   `base64 -i cert.p12 | pbcopy` → `CSC_LINK`.
2. **App-specific password**: at [account.apple.com](https://account.apple.com)
   → Sign-In and Security → App-Specific Passwords, generate one
   → `APPLE_APP_SPECIFIC_PASSWORD` (with the account email as `APPLE_ID`).
3. **Team ID**: developer.apple.com → Membership details
   → `APPLE_TEAM_ID`.
4. Add all five as GitHub **repository secrets** (Settings → Secrets and
   variables → Actions). The next `vX.Y.Z` tag produces a signed, notarized
   DMG/zip, and mac auto-update starts working from that release onward.

### Windows code signing (kills the SmartScreen warning)

Unsigned installers trigger SmartScreen's "Windows protected your PC" (More
info → Run anyway) and browser "not commonly downloaded" warnings. The
release workflow signs the Windows leg when secrets for **any** of the three
identities below are present (checked in this order); with none it builds
unsigned exactly as before.

**Option A — SignPath Foundation (recommended: FREE for open source).**
SignPath signs OSS builds at no cost on their HSM; the publisher on the
certificate reads "SignPath Foundation" and they vouch that the binary was
built from this repo's CI. Switchyard's MIT license satisfies their
OSI-license requirement. One-time setup:

1. Apply at [signpath.org](https://signpath.org) with the repo URL (they
   review that the project is real, released, and actively maintained).
   All maintainers need MFA enabled on GitHub and SignPath.
2. After approval, in the SignPath app create the **project** (artifact
   configuration: a single Windows PE executable) and a **release-signing
   policy**. Note the organization id and both slugs; create a CI API token.
3. Add repository secrets:

| Repo secret | What it is |
| --- | --- |
| `SIGNPATH_API_TOKEN` | CI user API token |
| `SIGNPATH_ORG_ID` | Organization id (GUID) |
| `SIGNPATH_PROJECT_SLUG` | Project slug |
| `SIGNPATH_POLICY_SLUG` | Signing policy slug (e.g. `release-signing`) |

The workflow then builds the exe unpublished, submits it to SignPath, waits
for the signature (release policies typically require a one-click approval
in the SignPath UI — the job pauses until then), regenerates the
blockmap + `latest.yml` hashes the signing invalidated, and uploads all
three to the draft release.

**Option B — Azure Trusted Signing.** ~$10/month, SmartScreen trusts it
immediately (no reputation-building period), publisher shows your verified
name. One-time setup:

1. In the [Azure portal](https://portal.azure.com), create a **Trusted
   Signing account** (note its region **endpoint**, e.g.
   `https://eus.codesigning.azure.net`), complete **identity validation**
   (individual or organization), and create a **certificate profile**
   (Public Trust).
2. Create an app registration (service principal) with a client secret and
   give it the **Trusted Signing Certificate Profile Signer** role on the
   account.
3. Add repository secrets — none of the values may contain spaces:

| Repo secret | What it is |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant id of the service principal |
| `AZURE_CLIENT_ID` | App registration (client) id |
| `AZURE_CLIENT_SECRET` | Client secret value |
| `AZURE_SIGNING_ENDPOINT` | Trusted Signing regional endpoint URI |
| `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name |

**Option C — classic PFX certificate** (e.g. an OV cert; Certum sells a
discounted open-source one, ~€69/year). SmartScreen keeps warning until the
certificate accumulates reputation, so expect weeks of "Run anyway" even
signed:

| Repo secret | What it is |
| --- | --- |
| `WIN_CSC_LINK` | Base64 of the certificate as a `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | The `.pfx` export password |

The next `vX.Y.Z` tag after adding either set produces a signed
`Switchyard-Setup-<version>.exe`. (Later, once every user is on a signed
build, `win.verifyUpdateCodeSignature`/`publisherName` can be enabled so
auto-updates verify the signature too.)

### winget distribution (free, sidesteps SmartScreen without signing)

SmartScreen's "Windows protected your PC" dialog is triggered by the
mark-of-the-web that browsers stamp on downloaded files. Installers fetched
by `winget install sbdeals.Switchyard` never pass through a browser, so the
dialog simply doesn't appear — signed or not. This doesn't replace signing
(README download buttons still warn until a certificate exists); it adds a
warning-free install path that costs nothing.

The release workflow's `winget` job keeps the manifest current: on every
`vX.Y.Z` tag it submits a version-bump PR to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) via
`wingetcreate`, then their automated validation + a moderator merge it
(typically within a day or two). Like the signing legs it's opt-in: without
the secret below the job logs a skip and stays green.

One-time setup:

1. **Bootstrap the package** (the auto-bump job can only *update* an existing
   package). With any published release live, run on a Windows machine:

   ```
   winget install wingetcreate
   wingetcreate new https://github.com/sbdeals/Switchyard/releases/download/vX.Y.Z/Switchyard-Setup-X.Y.Z.exe
   ```

   Use the version-numbered installer URL, **not** the stable
   `…/latest/download/Switchyard-Setup-Windows.exe` alias — winget manifests
   pin an exact URL + SHA-256 per version, and the alias's contents change
   every release. Suggested answers: package identifier `sbdeals.Switchyard`,
   moniker `switchyard`, license `MIT`, installer type is auto-detected
   (NSIS). Let `wingetcreate` submit the PR, then wait for winget-pkgs to
   merge it.
2. **Add the repo secret** `WINGET_TOKEN`: a classic GitHub PAT with the
   `public_repo` scope (it only needs to fork winget-pkgs and open PRs
   there). Every later release tag then bumps the manifest automatically.
