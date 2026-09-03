import type { SwitchyardConfig } from "./config.js";
import { metricsStoreUrl } from "./config.js";
import { docker, dockerInherit, dockerOk } from "./docker.js";
import { UserError } from "./errors.js";
import { sha256, sleep } from "./util.js";

export const CONTAINER_NAME = "switchyard";
export const NETWORK_NAME = "dokploy-network";
const HASH_LABEL = "switchyard.config-hash";

export interface ContainerPlan {
  image: string;
  bindHost: string;
  runArgs: string[];
  /** Fingerprint of everything that affects the running container. */
  hash: string;
}

/**
 * Render the desired `docker run` for the dashboard container. Deterministic:
 * the hash only changes when config that matters to the container changes,
 * which is what makes `up` idempotent and `config set` a targeted recreate.
 */
export function renderContainer(cfg: SwitchyardConfig, cliVersion: string): ContainerPlan {
  const tag = cfg.imageTag || cliVersion;
  const image = `${cfg.image}:${tag}`;
  const bindHost = cfg.expose ? "0.0.0.0" : "127.0.0.1";
  const env: Record<string, string> = {
    DOKPLOY_URL: cfg.dokployUrlInContainer,
    // Host-facing origin for URLs that leave the server (deploy webhooks,
    // browser links) — a Git host or browser can't resolve the service-DNS
    // URL. The dashboard also keeps it as an auth-Origin fallback for older
    // Dokploy builds, which only trust host-facing origins (current builds
    // trust the request Host instead; the dashboard probes both).
    DOKPLOY_ORIGIN: `http://localhost:${cfg.dokployPort}`,
    DOKPLOY_EMAIL: cfg.adminEmail,
    DOKPLOY_PASSWORD: cfg.adminPassword,
    // Signs the dashboard's session cookie. Part of the spec, so it folds into
    // the config-hash: rotating it recreates the container (and logs users out).
    SWITCHYARD_SESSION_SECRET: cfg.sessionSecret,
    // Durable observability store (persist metrics/logs, threshold alerts).
    // Empty when disabled → the dashboard runs persistence-off. Part of `env`,
    // so it is folded into the config-hash and keeps `up` idempotent.
    SWITCHYARD_STORE_URL: metricsStoreUrl(cfg),
  };
  // Host IP for auto-URL on app deploys. Only set on Linux (Traefik managed);
  // its presence is the dashboard's signal that auto-URL is safe. Added only
  // when non-empty so an unset value leaves the hash (and Docker Desktop
  // containers) unchanged; a changed IP recreates the container.
  if (cfg.hostIp) env.SWITCHYARD_HOST_IP = cfg.hostIp;
  // Force the Secure attribute on the session cookie for TLS proxies that omit
  // X-Forwarded-Proto. Added only when on, so the default hash is unchanged.
  if (cfg.assumeHttps) env.SWITCHYARD_ASSUME_HTTPS = "1";
  const spec = {
    image,
    network: NETWORK_NAME,
    publish: `${bindHost}:${cfg.dashboardPort}:3001`,
    socket: "/var/run/docker.sock:/var/run/docker.sock",
    env,
    restart: "unless-stopped",
  };
  const hash = sha256(JSON.stringify(spec));
  const runArgs = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    spec.restart,
    "--network",
    spec.network,
    "-p",
    spec.publish,
    "-v",
    spec.socket,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-l",
    "switchyard.managed=true",
    "-l",
    `${HASH_LABEL}=${hash}`,
    image,
  ];
  return { image, bindHost, runArgs, hash };
}

export type EnsureResult = "unchanged" | "created" | "recreated";

export async function ensureSwitchyard(
  cfg: SwitchyardConfig,
  cliVersion: string,
  log: (msg: string) => void,
): Promise<EnsureResult> {
  const plan = renderContainer(cfg, cliVersion);

  if (!(await dockerOk(["network", "inspect", NETWORK_NAME]))) {
    throw new UserError(
      `Network ${NETWORK_NAME} does not exist — the Dokploy install looks incomplete. Re-run \`switchyard up\`.`,
    );
  }

  const existing = await docker([
    "inspect",
    CONTAINER_NAME,
    "--format",
    `{{ index .Config.Labels "${HASH_LABEL}" }}|{{ .State.Running }}`,
  ]);
  const exists = existing.code === 0;
  if (exists) {
    const [hash, running] = existing.stdout.trim().split("|");
    if (hash === plan.hash && running === "true") return "unchanged";
  }

  // Pull first so the old container keeps serving until the swap.
  log(`Pulling ${plan.image} ...`);
  const pulled = (await dockerInherit(["pull", plan.image])) === 0;
  if (!pulled) {
    const haveLocal = await dockerOk(["image", "inspect", plan.image]);
    if (haveLocal) {
      log(`Pull failed; using the local ${plan.image} image.`);
    } else {
      throw new UserError(
        `Could not pull ${plan.image} and no local copy exists.\n` +
          `  - published releases: re-run with \`--tag latest\`\n` +
          `  - from a repo checkout: docker build -t ${plan.image} dashboard/`,
      );
    }
  }

  if (exists) await docker(["rm", "-f", CONTAINER_NAME]);
  const res = await docker(plan.runArgs);
  if (res.code !== 0) {
    throw new UserError(`docker run for ${CONTAINER_NAME} failed:\n${res.stderr.trim()}`);
  }
  return exists ? "recreated" : "created";
}

export interface HealthReport {
  shallow: boolean;
  deep: boolean;
  deepError?: string;
}

/** Poll the shallow health endpoint, then verify Dokploy reachability once. */
export async function waitSwitchyardHealthy(
  dashboardPort: number,
  timeoutMs = 120_000,
): Promise<HealthReport> {
  const base = `http://127.0.0.1:${dashboardPort}`;
  const start = Date.now();
  let shallow = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        shallow = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  if (!shallow) return { shallow: false, deep: false };

  try {
    const res = await fetch(`${base}/api/health?deep=1`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) return { shallow: true, deep: true };
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep status */
    }
    return { shallow: true, deep: false, deepError: message };
  } catch (e) {
    return { shallow: true, deep: false, deepError: e instanceof Error ? e.message : String(e) };
  }
}
