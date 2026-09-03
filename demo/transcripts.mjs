#!/usr/bin/env node
/**
 * API transcripts for the authZ findings. Each finding writes NN-*.md and a
 * rendered NN-*.png into the output dir.
 *
 *   node transcripts.mjs <finding> <dashboardBase> <outDir> [stubLog]
 *
 * findings:
 *   forged     05  forged session cookie against the agent/metrics routes (stub UP)
 *   expired    06  expired (iat - 8d) but correctly sealed cookie              (stub UP)
 *   crossuser  07  process-global allow-list cache leaking alice's app to bob  (stub UP)
 *   history    08  metrics/history has no service allow-list                   (stub UP)
 *   failopen   09  http-metrics falls OPEN when Dokploy is unreachable         (stub DOWN)
 *   collector  10  count project.all hits in the stub log over an idle window  (stub UP, needs stubLog)
 *   online     05+06+07+08 in sequence
 *
 * env: SWITCHYARD_SESSION_SECRET (default demo-secret-do-not-use), PW_DIR, CHROME_PATH
 */
import { readFileSync } from "node:fs";
import { cookies, launch, probe, renderPng, resultsTable, writeText } from "./lib.mjs";

const [finding, base, outDir, stubLog] = process.argv.slice(2);
if (!finding || !base || !outDir) {
  console.error("usage: transcripts.mjs <finding> <dashboardBase> <outDir> [stubLog]");
  process.exit(1);
}
const C = cookies();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

async function emit(browser, file, title, subtitle, markdown) {
  writeText(`${outDir}/${file}.md`, `# ${title}\n\n${subtitle}\n\n${markdown}\n`);
  await renderPng(browser, { title, subtitle, markdown }, `${outDir}/${file}.png`);
  console.log(`wrote ${outDir}/${file}.md + .png`);
}

async function forged(browser) {
  const rows = [];
  const f = C.forged;
  rows.push(await probe(base, "/api/agent/config", { cookie: f }));
  rows.push({ ...(await probe(base, "/api/agent/config", { method: "POST", cookie: f, body: { key: "sk-ant-demo-forged-1234567890" } })), note: "(body: set shared agent key)" });
  rows.push({ ...(await probe(base, "/api/agent/config", { cookie: f })), note: "(re-read: did the forged key stick?)" });
  rows.push({ ...(await probe(base, "/api/agent/config", { method: "POST", cookie: f, body: { clear: true } })), note: "(cleanup: clear key)" });
  rows.push(await probe(base, "/api/agent/models", { cookie: f }));
  rows.push(await probe(base, "/api/agent/oauth/start", { method: "POST", cookie: f }));
  rows.push(await probe(base, "/api/agent/changes", { cookie: f }));
  rows.push(await probe(base, "/api/services/metrics/history?app=alpha-db", { cookie: f }));
  rows.push(await probe(base, "/api/services/http-metrics?app=alpha-db", { cookie: f }));
  rows.push(await probe(base, "/api/services/logs?app=alpha-db", { cookie: f }));
  await emit(
    browser,
    "05-authz-forged-cookie",
    "P0: forged session cookie vs. API routes",
    `Cookie: switchyard_session=forged-garbage (not sealed with the server secret). Captured ${stamp()} against ${base}. Expected after the fix: every row 401.`,
    resultsTable(rows),
  );
}

async function expired(browser) {
  const rows = [];
  const e = C.expiredAlice;
  rows.push({ ...(await probe(base, "/", { cookie: e })), note: "(page)" });
  rows.push(await probe(base, "/login", { cookie: e }));
  rows.push(await probe(base, "/api/agent/config", { cookie: e }));
  rows.push(await probe(base, "/api/services/metrics/history?app=alpha-db", { cookie: e }));
  rows.push(await probe(base, "/api/services/http-metrics?app=alpha-db", { cookie: e }));
  await emit(
    browser,
    "06-authz-expired-cookie",
    "P1: session age never enforced server-side",
    `Cookie correctly sealed for alice but iat = now - 8 days (SESSION_MAX_AGE is 7 days). Captured ${stamp()} against ${base}. Expected after the fix: / redirects to /login (307), /login serves the form (200), API rows 401.`,
    resultsTable(rows),
  );
}

async function crossuser(browser) {
  const rows = [];
  rows.push({ ...(await probe(base, "/api/services/metrics?app=alpha-db", { cookie: C.alice })), note: "(as ALICE: primes the allow-list cache with {alpha-db})" });
  rows.push({ ...(await probe(base, "/api/services/metrics?app=alpha-db", { cookie: C.bob })), note: "(as BOB, within 30s: alpha-db is NOT bob's service)" });
  rows.push({ ...(await probe(base, "/api/services/http-metrics?app=alpha-db", { cookie: C.bob })), note: "(as BOB)" });
  rows.push({ ...(await probe(base, "/api/services/logs?app=alpha-db", { cookie: C.bob })), note: "(as BOB)" });
  rows.push({ ...(await probe(base, "/api/services/metrics?app=beta-db", { cookie: C.bob })), note: "(as BOB: bob's OWN service — served from alice's cached allow-list?)" });
  console.log("waiting 32s for the 30s cache TTL to lapse…");
  await sleep(32_000);
  rows.push({ ...(await probe(base, "/api/services/metrics?app=alpha-db", { cookie: C.bob })), note: "(as BOB, after the 30s TTL: cache rebuilt from bob's workspace)" });
  await emit(
    browser,
    "07-cross-user-allowlist",
    "P0: process-global allow-list cache leaks across users",
    `knownAppNames() caches the LAST caller's service allow-list for 30s with no session key. alice owns alpha-db, bob owns beta-db (fake Dokploy). Captured ${stamp()} against ${base}. Before: rows 2-4 serve alice's app to bob (200) and row 5 denies bob his own app (403). Expected after the fix: rows 2-4 403, row 5 200, row 6 403.`,
    resultsTable(rows),
  );
}

async function history(browser) {
  const rows = [];
  rows.push({ ...(await probe(base, "/api/services/metrics/history?app=alpha-db", { cookie: C.alice })), note: "(alice's own service)" });
  rows.push({ ...(await probe(base, "/api/services/metrics/history?app=beta-db", { cookie: C.alice })), note: "(bob's service, requested by alice)" });
  rows.push({ ...(await probe(base, "/api/services/metrics/history?app=totally-unknown-app", { cookie: C.alice })), note: "(not a Dokploy service at all)" });
  rows.push({ ...(await probe(base, "/api/services/metrics/history?app=alpha-db", { cookie: C.bob })), note: "(alice's service, requested by bob)" });
  await emit(
    browser,
    "08-metrics-history-no-allowlist",
    "P0: metrics/history has no service allow-list",
    `Valid sessions, but the route never checks that ?app= belongs to the caller (no durable store is configured here, so bodies are {enabled:false}; with a store they would be real samples). Captured ${stamp()} against ${base}. Expected after the fix: row 1 200, rows 2-4 403.`,
    resultsTable(rows),
  );
}

async function failopen(browser) {
  const rows = [];
  rows.push({ ...(await probe(base, "/api/services/http-metrics?app=alpha-db", { cookie: C.alice })), note: "(valid session, Dokploy UNREACHABLE)" });
  rows.push({ ...(await probe(base, "/api/services/http-metrics?app=anything-at-all", { cookie: C.alice })), note: "(valid session, Dokploy UNREACHABLE, arbitrary app)" });
  rows.push({ ...(await probe(base, "/api/services/metrics?app=alpha-db", { cookie: C.alice })), note: "(control: the live metrics route already fails closed)" });
  await emit(
    browser,
    "09-http-metrics-fail-open",
    "P0: http-metrics falls OPEN when the allow-list can't be built",
    `Fake Dokploy stopped before these requests. Captured ${stamp()} against ${base}. Before: http-metrics answers 200 for any app name (known=null skips the check). Expected after the fix: 503 for rows 1-2 (fail closed), row 3 unchanged.`,
    resultsTable(rows),
  );
}

/** Watch the stub log for `ms` and summarise who made which Dokploy calls. */
async function watchWindow(ms) {
  const before = readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
  const t0 = Date.now();
  await sleep(ms);
  const fresh = readFileSync(stubLog, "utf8").split("\n").filter(Boolean).slice(before.length);
  const byUser = {};
  for (const l of fresh) {
    const [, , path, user, status] = l.split(" | ").map((s) => s.trim());
    if (!path.startsWith("/api/project.all")) continue;
    const k = `${user} -> ${status}`;
    byUser[k] = (byUser[k] ?? 0) + 1;
  }
  const signins = fresh.filter((l) => l.includes("/api/auth/sign-in/email")).length;
  return { t0, t1: Date.now(), fresh, byUser, signins };
}

function windowTable(w) {
  const rows = Object.entries(w.byUser).map(([k, n]) => `| \`project.all\` as ${k} | **${n}** |`);
  return [
    `Window ${new Date(w.t0).toISOString()} -> ${new Date(w.t1).toISOString()} (idle, no browser/API traffic, collector interval 5000ms, ~8 ticks expected).`,
    "",
    "| Dokploy calls during the window | Count |",
    "|---|---|",
    ...(rows.length ? rows : ["| `project.all` (any user) | **0** |"]),
    `| sign-ins (\`/api/auth/sign-in/email\`) | **${w.signins}** |`,
    "",
    "```",
    w.fresh.length ? w.fresh.join("\n") : "(no Dokploy requests at all)",
    "```",
  ].join("\n");
}

async function collector(browser) {
  if (!stubLog) throw new Error("collector finding needs the stub log path");
  // The dashboard was (re)started with DOKPLOY_EMAIL=admin@demo.test. The first
  // workspace render — as ALICE — is what starts the collector.
  await probe(base, "/", { cookie: C.alice });
  await sleep(2_000);
  console.log("window A: idle-watching the stub log for 30s…");
  const a = await watchWindow(30_000);
  // Now alice's Dokploy session goes away (logout / expiry). A collector with
  // its own system session should not care.
  await fetch(`${new URL(base).protocol}//127.0.0.1:3971/__demo/revoke?token=alice`, { method: "POST" });
  console.log("window B: alice's Dokploy session revoked; watching 30s more…");
  const b = await watchWindow(30_000);
  await fetch(`${new URL(base).protocol}//127.0.0.1:3971/__demo/restore?token=alice`, { method: "POST" });
  const md = [
    "## Window A: who does the collector run as?",
    "",
    windowTable(a),
    "",
    "## Window B: after alice's Dokploy session is revoked",
    "",
    windowTable(b),
  ].join("\n");
  await emit(
    browser,
    "10-collector",
    "P1: background collector borrows the first user's request context",
    `Observed (not the 'dies after one tick' hunch): setInterval inherits the async context of the request that started the collector, so every tick calls Dokploy with THAT user's session cookie — here alice's — instead of the DOKPLOY_EMAIL system identity (admin@demo.test). Once that user's Dokploy session ends, ticks hit 401 -> redirect() throws inside a timer -> swallowed; collection stops for good with no log line. Captured ${stamp()} against ${base}. Expected after the fix: window A/B both show project.all as admin (after a sign-in), unaffected by alice's revocation.`,
    md,
  );
}

const browser = await launch();
try {
  const run = { forged, expired, crossuser, history, failopen, collector };
  if (finding === "online") {
    await forged(browser);
    await expired(browser);
    await history(browser);
    await crossuser(browser);
  } else if (run[finding]) {
    await run[finding](browser);
  } else {
    throw new Error(`unknown finding ${finding}`);
  }
} finally {
  await browser.close();
}
