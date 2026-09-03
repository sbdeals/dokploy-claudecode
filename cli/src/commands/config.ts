import {
  CONFIG_KEY_TYPES,
  coerceConfigValue,
  loadConfig,
  saveConfig,
  type ConfigKey,
} from "../core/config.js";
import { dockerOk, probeDocker } from "../core/docker.js";
import { UserError } from "../core/errors.js";
import { p, pc } from "../core/prompts.js";
import {
  CONTAINER_NAME,
  ensureSwitchyard,
  waitSwitchyardHealthy,
} from "../core/switchyard-container.js";
import { CLI_VERSION } from "../version.js";

export interface ConfigFlags {
  restart?: boolean; // commander --no-restart -> restart:false
  showSecrets?: boolean;
}

const SECRET_KEYS: ConfigKey[] = ["adminPassword", "sessionSecret"];

function assertKey(key: string): ConfigKey {
  if (!(key in CONFIG_KEY_TYPES)) {
    throw new UserError(
      `Unknown config key: ${key}\nValid keys: ${Object.keys(CONFIG_KEY_TYPES).join(", ")}`,
    );
  }
  return key as ConfigKey;
}

export async function configCommand(
  action: string,
  key: string | undefined,
  value: string | undefined,
  flags: ConfigFlags,
): Promise<void> {
  const { config: cfg, path } = loadConfig();

  switch (action) {
    case "list": {
      console.log(pc.dim(`# ${path}`));
      for (const k of Object.keys(CONFIG_KEY_TYPES) as ConfigKey[]) {
        const raw = cfg[k];
        const shown =
          SECRET_KEYS.includes(k) && !flags.showSecrets && raw !== ""
            ? "********  (use --show-secrets)"
            : String(raw);
        console.log(`${k} = ${shown}`);
      }
      return;
    }
    case "get": {
      if (!key) throw new UserError("Usage: switchyard config get <key>");
      const k = assertKey(key);
      console.log(String(cfg[k]));
      return;
    }
    case "set": {
      if (!key || value === undefined) throw new UserError("Usage: switchyard config set <key> <value>");
      const k = assertKey(key);
      const coerced = coerceConfigValue(k, value);
      if (k === "expose" && coerced === true) {
        p.log.warn(
          "expose=true publishes the dashboard on ALL interfaces. It requires a Dokploy login, but has no TLS — front it with an HTTPS proxy off trusted networks. Applied on the next container recreate.",
        );
      }
      if (k === "sessionSecret") {
        p.log.warn("Rotating sessionSecret signs out every logged-in user on the next container recreate.");
      }
      if (k === "assumeHttps" && coerced === true) {
        p.log.warn(
          "assumeHttps=true marks the session cookie Secure unconditionally. Only use it behind an HTTPS proxy that terminates TLS: over plain HTTP the browser drops the cookie and nobody can sign in.",
        );
      }
      (cfg as Record<ConfigKey, unknown>)[k] = coerced;
      saveConfig(cfg, path);
      p.log.success(`${k} = ${SECRET_KEYS.includes(k) && !flags.showSecrets ? "********" : String(coerced)} (saved to ${path})`);

      if (k === "dokployPort") {
        p.log.info("Changing the Dokploy port also needs the service re-published — run `switchyard up` to converge.");
      }
      if (k === "localIngress" && coerced === true) {
        p.log.info("Start the demo proxy with `switchyard local-ingress up` (or it converges on the next `switchyard up`).");
      }

      if (flags.restart === false) {
        p.log.info("Skipped container restart (--no-restart). Apply later with `switchyard up`.");
        return;
      }
      if ((await probeDocker()).availability !== "ok" || !(await dockerOk(["container", "inspect", CONTAINER_NAME]))) {
        p.log.info("No running Switchyard container to update — the setting applies on the next `switchyard up`.");
        return;
      }
      const result = await ensureSwitchyard(cfg, CLI_VERSION, (m) => p.log.step(m));
      if (result === "unchanged") {
        p.log.info("Container spec unchanged — nothing to restart.");
        return;
      }
      const health = await waitSwitchyardHealthy(cfg.dashboardPort);
      if (health.deep) p.log.success("Container recreated and healthy.");
      else if (health.shallow) p.log.warn(`Container recreated but the Dokploy probe failed: ${health.deepError ?? "unknown"}`);
      else p.log.warn(`Container recreated but not answering yet — check \`docker logs ${CONTAINER_NAME}\`.`);
      return;
    }
    default:
      throw new UserError(`Unknown config action: ${action} (expected list|get|set)`);
  }
}
