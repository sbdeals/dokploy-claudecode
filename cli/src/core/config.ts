import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { UserError } from "./errors.js";

export type Platform = "linux" | "docker-desktop";

/**
 * Everything `switchyard up` decides or asks for, persisted so re-runs and
 * `switchyard config` converge on the same state. Contains the Dokploy admin
 * password — written 0600.
 */
export interface SwitchyardConfig {
  schemaVersion: 1;
  platform: Platform;
  /** Host port Dokploy is published on (adopted from an existing install). */
  dokployPort: number;
  /** Host port the Switchyard container is published on. */
  dashboardPort: number;
  /** false = bind 127.0.0.1 (default; the dashboard has a login but no TLS). */
  expose: boolean;
  /**
   * Mark the dashboard's session cookie Secure even when the request carries no
   * `X-Forwarded-Proto: https` (an HTTPS proxy in front that omits the header).
   * Handed to the dashboard as SWITCHYARD_ASSUME_HTTPS=1. Only for TLS-fronted
   * setups: over plain HTTP the browser drops a Secure cookie and nobody can
   * sign in.
   */
  assumeHttps: boolean;
  /** Skip the Traefik proxy (defaults true on Docker Desktop, false on Linux). */
  skipTraefik: boolean;
  /**
   * Opt-in local ingress: run a demo Traefik on alternate host ports (Docker
   * Desktop, where skipTraefik is on). HTTP-only routing — NOT real TLS.
   * `switchyard local-ingress up/down` drives it; off by default.
   */
  localIngress: boolean;
  localIngressHttpPort: number;
  localIngressHttpsPort: number;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  /** Secret that signs the dashboard's session cookie (CSPRNG, seeded at install). */
  sessionSecret: string;
  /** Switchyard image repo (no tag). */
  image: string;
  /** Image tag; "" means "same as the CLI version". */
  imageTag: string;
  /** What the container uses to reach Dokploy (service DNS by default). */
  dokployUrlInContainer: string;
  /**
   * Host advertise/public IP, handed to the dashboard as SWITCHYARD_HOST_IP so
   * app deploys can mint an auto-URL with no manual DNS. Auto-detected on Linux
   * (from scripts/host-ip.sh); "" disables auto-URL (the Docker Desktop / dev
   * default, where Traefik isn't managed).
   */
  hostIp: string;
  /** Provision the switchyard-metrics Postgres for observability persistence. */
  store: boolean;
  /** CSPRNG password for the metrics store (generated once; 0600 with the file). */
  storePassword: string;
}

// The Switchyard-owned metrics store: a dedicated Postgres provisioned on
// dokploy-network, reached from the dashboard container by service DNS.
export const STORE_SERVICE = "switchyard-metrics";
export const STORE_VOLUME = "switchyard-metrics";
const STORE_USER = "switchyard";
const STORE_DB = "switchyard";
const STORE_PORT = 5432;

/**
 * The connection string handed to the dashboard as SWITCHYARD_STORE_URL. Empty
 * when the store is disabled or not yet provisioned — the dashboard treats an
 * empty value as "persistence off" (dev-mode behaviour).
 */
export function metricsStoreUrl(cfg: SwitchyardConfig): string {
  if (!cfg.store || !cfg.storePassword) return "";
  return `postgresql://${STORE_USER}:${encodeURIComponent(cfg.storePassword)}@${STORE_SERVICE}:${STORE_PORT}/${STORE_DB}`;
}

export function detectPlatform(): Platform {
  return process.platform === "linux" ? "linux" : "docker-desktop";
}

export function defaultConfig(platform: Platform = detectPlatform()): SwitchyardConfig {
  return {
    schemaVersion: 1,
    platform,
    dokployPort: 3000,
    dashboardPort: 3001,
    expose: false,
    assumeHttps: false,
    skipTraefik: platform !== "linux",
    localIngress: false,
    localIngressHttpPort: 8080,
    localIngressHttpsPort: 8443,
    adminName: "Admin",
    adminEmail: "",
    adminPassword: "",
    sessionSecret: "",
    image: "ghcr.io/sbdeals/switchyard",
    imageTag: "",
    dokployUrlInContainer: "http://dokploy:3000",
    hostIp: "",
    store: true,
    storePassword: "",
  };
}

/** Keys the `config` command may read/write, with coercion type. */
export const CONFIG_KEY_TYPES = {
  dokployPort: "number",
  dashboardPort: "number",
  expose: "boolean",
  assumeHttps: "boolean",
  skipTraefik: "boolean",
  localIngress: "boolean",
  localIngressHttpPort: "number",
  localIngressHttpsPort: "number",
  adminName: "string",
  adminEmail: "string",
  adminPassword: "string",
  sessionSecret: "string",
  image: "string",
  imageTag: "string",
  dokployUrlInContainer: "string",
  hostIp: "string",
  store: "boolean",
  storePassword: "string",
} as const satisfies Partial<Record<keyof SwitchyardConfig, "number" | "boolean" | "string">>;

export type ConfigKey = keyof typeof CONFIG_KEY_TYPES;

export function coerceConfigValue(key: ConfigKey, raw: string): number | boolean | string {
  const kind = CONFIG_KEY_TYPES[key];
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new UserError(`${key} must be an integer, got: ${raw}`);
    return n;
  }
  if (kind === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new UserError(`${key} must be true or false, got: ${raw}`);
  }
  return raw;
}

/**
 * Well-known per-OS location; `SWITCHYARD_CONFIG` overrides (also how tests
 * point at a temp file).
 */
export function configPath(): string {
  const override = process.env.SWITCHYARD_CONFIG;
  if (override) return override;
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA;
      return appData
        ? join(appData, "switchyard", "config.json")
        : join(homedir(), ".switchyard", "config.json");
    }
    case "darwin":
      return join(homedir(), "Library", "Application Support", "switchyard", "config.json");
    default:
      return "/etc/switchyard/config.json";
  }
}

export interface LoadedConfig {
  config: SwitchyardConfig;
  path: string;
  existed: boolean;
}

export function loadConfig(): LoadedConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { config: defaultConfig(), path, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(
      `Config file ${path} is not valid JSON (${e instanceof Error ? e.message : e}).\n` +
        `Fix it or delete it and re-run \`switchyard up\`.`,
    );
  }
  // Overlay onto defaults so configs written by older CLIs gain new keys.
  const config = { ...defaultConfig(), ...(parsed as Partial<SwitchyardConfig>), schemaVersion: 1 as const };
  return { config, path, existed: true };
}

export function saveConfig(config: SwitchyardConfig, path = configPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    throw new UserError(
      `Cannot write the config file ${path} (${code}).\n` +
        (process.platform === "linux"
          ? "Writing /etc/switchyard needs root — re-run with sudo."
          : "Check the directory permissions, or point SWITCHYARD_CONFIG at a writable path."),
    );
  }
  try {
    chmodSync(path, 0o600); // contains the admin password; no-op on Windows
  } catch {
    /* Windows ACLs don't map to POSIX modes */
  }
}
