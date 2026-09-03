/**
 * Server-side metrics/logs collector.
 *
 * Lifecycle: a lazy singleton started on the first workspace render
 * (`ensureCollector()` is called from `app/page.tsx`). It samples container
 * stats and tails logs for every known service on a fixed interval — tab open
 * or not — so history survives a closed drawer, and it watches the same signal
 * for crash-loops. It runs inside the long-lived Next.js Node server; the
 * `globalThis` guard makes it start exactly once across HMR reloads and repeated
 * imports. It self-disables when neither persistence nor alerting is configured.
 *
 * Nothing here throws to the render path: every tick is wrapped so a Dokploy or
 * Docker hiccup just skips a cycle.
 */
import "server-only";
import {
  hasSystemCredentials,
  loadWorkspace,
  notifyThroughDokploy,
  withSystemSession,
  type Service,
} from "./dokploy";
import { sampleStatsOnce, containerHealth, readRecentLogs } from "./docker";
import { storeEnabled, writeMetric, writeLogs, pruneOld } from "./store";
import {
  observe,
  newCrashLoopState,
  DEFAULT_CRASH_LOOP,
  type CrashLoopState,
  type CrashLoopConfig,
} from "./crash-loop";

const num = (v: string | undefined, d: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};

const INTERVAL_MS = num(process.env.SWITCHYARD_COLLECT_INTERVAL_MS, 20_000);
const METRICS_RETENTION_MS = num(process.env.SWITCHYARD_METRICS_RETENTION_MS, 7 * 24 * 60 * 60_000);
const LOG_RETENTION_MS = num(process.env.SWITCHYARD_LOG_RETENTION_MS, 24 * 60 * 60_000);
const LOG_TAIL = 100;

const ALERT_SELECTOR = process.env.SWITCHYARD_ALERT_NOTIFICATION?.trim() || undefined;
const alertsEnabled = !/^(0|false|off)$/i.test(process.env.SWITCHYARD_ALERTS ?? "");
const crashCfg: CrashLoopConfig = {
  threshold: num(process.env.SWITCHYARD_ALERT_RESTART_THRESHOLD, DEFAULT_CRASH_LOOP.threshold),
  cooldownMs: num(process.env.SWITCHYARD_ALERT_COOLDOWN_MS, DEFAULT_CRASH_LOOP.cooldownMs),
};

interface CollectorRuntime {
  started: boolean;
  timer: NodeJS.Timeout | null;
  crash: Map<string, CrashLoopState>;
  lastLogTs: Map<string, number>;
  ticks: number;
  /** Last system-session failure message, so an outage is logged once, not per tick. */
  lastSystemError: string | null;
}

// Survive HMR / multiple imports: one runtime per process.
const g = globalThis as unknown as { __switchyardCollector?: CollectorRuntime };
const rt: CollectorRuntime =
  g.__switchyardCollector ??
  (g.__switchyardCollector = {
    started: false,
    timer: null,
    crash: new Map(),
    lastLogTs: new Map(),
    ticks: 0,
    lastSystemError: null,
  });

/** Whether the container of an expected-up service looks crash-looping. */
function isUnhealthy(service: Service, state: string | null, running: boolean): boolean {
  // A Dokploy `error` status is itself a crash signal.
  if (service.status === "error") return true;
  // Only services Dokploy expects to be running can be "crash-looping";
  // idle/stopped/one-shot-done services simply aren't.
  if (service.status !== "running") return false;
  if (!running) return true;
  return state === "restarting" || state === "dead" || state === "exited";
}

async function collectOne(service: Service, now: number): Promise<void> {
  const app = service.appName;
  if (!app) return;

  if (storeEnabled()) {
    const sample = await sampleStatsOnce(app);
    if (sample) await writeMetric(app, sample);

    const lines = await readRecentLogs(app, LOG_TAIL);
    const since = rt.lastLogTs.get(app) ?? 0;
    const fresh = lines.filter((l) => l.ts > since);
    if (fresh.length > 0) {
      await writeLogs(app, fresh);
      rt.lastLogTs.set(app, fresh[fresh.length - 1].ts);
    }
  }

  if (alertsEnabled) {
    const health = await containerHealth(app);
    let st = rt.crash.get(app);
    if (!st) {
      st = newCrashLoopState();
      rt.crash.set(app, st);
    }
    const unhealthy = isUnhealthy(service, health.state, health.running);
    const fire = observe(st, { unhealthy, restartCount: health.restartCount }, crashCfg, now);
    if (fire) {
      const text =
        `🚨 Switchyard: "${service.name}" (${app}) appears to be crash-looping — ` +
        `Dokploy status "${service.status}", container ${health.state ?? "missing"}` +
        `${health.restartCount != null ? `, restarts ${health.restartCount}` : ""}. ` +
        `Project ${service.projectName} / ${service.environmentName}.`;
      const res = await notifyThroughDokploy(text, ALERT_SELECTOR);
      if (res.sent) console.warn(`[collector] crash-loop alert sent for ${app} via ${res.channel} (${res.name})`);
      else console.warn(`[collector] crash-loop on ${app} but no alert sent: ${res.reason}`);
    }
  }
}

/**
 * One sampling cycle. Runs from a timer. Without an explicit session it would
 * inherit the async context of whichever request first started the timer and
 * keep borrowing THAT user's cookie for every later tick (until their Dokploy
 * session expired, after which every tick 401'd silently): the caller wraps
 * this in `withSystemSession`, so every Dokploy call below uses the env admin
 * session instead of a user's.
 */
async function collect(): Promise<void> {
  let services: Service[];
  try {
    ({ services } = await loadWorkspace());
  } catch {
    return; // Dokploy unreachable this cycle — try again next tick.
  }
  const now = Date.now();
  const seen = new Set<string>();
  for (const s of services) {
    if (s.appName) seen.add(s.appName);
    try {
      await collectOne(s, now);
    } catch (e) {
      console.warn(`[collector] ${s.appName || s.name} failed:`, e instanceof Error ? e.message : e);
    }
  }
  // Forget state for services that no longer exist.
  for (const key of rt.crash.keys()) if (!seen.has(key)) rt.crash.delete(key);
  for (const key of rt.lastLogTs.keys()) if (!seen.has(key)) rt.lastLogTs.delete(key);

  // Prune roughly hourly.
  if (storeEnabled() && rt.ticks % Math.max(1, Math.round(3_600_000 / INTERVAL_MS)) === 0) {
    await pruneOld(METRICS_RETENTION_MS, LOG_RETENTION_MS, now).catch(() => {});
  }
}

async function tick(): Promise<void> {
  rt.ticks += 1;
  try {
    await withSystemSession(collect);
    rt.lastSystemError = null;
  } catch (e) {
    // Admin sign-in failed (wrong DOKPLOY_EMAIL/PASSWORD, Dokploy down, or the
    // session was rejected mid-cycle): skip this cycle. Log once per distinct
    // failure so a long outage doesn't fill the log every interval.
    const message = e instanceof Error ? e.message : String(e);
    if (message !== rt.lastSystemError) {
      rt.lastSystemError = message;
      console.warn(`[collector] system session unavailable, skipping cycle: ${message}`);
    }
  }
}

/**
 * Start the collector once. No-op when neither persistence nor alerts are on,
 * or when there are no admin credentials to run the background session with.
 */
export function ensureCollector(): void {
  if (rt.started) return;
  if (!storeEnabled() && !alertsEnabled) return;
  if (!hasSystemCredentials()) {
    rt.started = true; // env is fixed for the process; warn once, not per render
    console.warn(
      "[collector] disabled: DOKPLOY_EMAIL / DOKPLOY_PASSWORD are not set, so there is no system session for background sampling.",
    );
    return;
  }
  rt.started = true;
  const loop = () => {
    void tick();
  };
  loop(); // prime immediately so history starts filling
  rt.timer = setInterval(loop, INTERVAL_MS);
  // Don't let the collector keep the process alive on shutdown.
  rt.timer.unref?.();
  console.warn(
    `[collector] started (interval ${INTERVAL_MS}ms, store ${storeEnabled() ? "on" : "off"}, alerts ${alertsEnabled ? "on" : "off"})`,
  );
}
