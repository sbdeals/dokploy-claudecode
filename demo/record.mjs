#!/usr/bin/env node
/**
 * Screen recordings (Playwright recordVideo -> .webm) of the hardening flows,
 * before vs after. Each clip gets a caption strip at the bottom of the page
 * naming the step, the identity/cookie in use, and what main vs the fix shows.
 *
 *   node record.mjs <clip|all> <dashboardBase> <rawWebmDir> <before|after>
 *
 * clips:
 *   login      01-login-and-create-account
 *   forged     02-forged-cookie-api
 *   crossuser  03-cross-user-allowlist
 *   expired    04-expired-cookie
 *
 * Convert afterwards with:
 *   ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p -crf 22 -preset medium -r 30 -movflags +faststart out.mp4
 *
 * env: SWITCHYARD_SESSION_SECRET (default demo-secret-do-not-use), PW_DIR, CHROME_PATH
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { cookies, launch, probe } from "./lib.mjs";

const [clipArg, base, rawDir, label] = process.argv.slice(2);
if (!clipArg || !base || !rawDir || !label) {
  console.error("usage: record.mjs <clip|all> <dashboardBase> <rawWebmDir> <before|after>");
  process.exit(1);
}
mkdirSync(rawDir, { recursive: true });
const C = cookies();
const host = new URL(base).hostname;
const SIZE = { width: 1280, height: 800 };
const TYPE_DELAY = 70;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Caption strip (fixed bottom bar) injected into whatever page is showing.
// ---------------------------------------------------------------------------
async function caption(page, lines, { withTitle = false } = {}) {
  const all = [...lines];
  if (withTitle) all.push(`document.title = "${await page.title()}"    location = ${page.url()}`);
  await page.evaluate(
    ({ all, label }) => {
      let bar = document.getElementById("__demo_caption");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__demo_caption";
        Object.assign(bar.style, {
          position: "fixed",
          left: "0",
          right: "0",
          bottom: "0",
          zIndex: "2147483647",
          background: "rgba(8, 10, 16, 0.94)",
          color: "#f2f4f8",
          font: "20px/1.35 -apple-system, 'Helvetica Neue', Arial, sans-serif",
          padding: "12px 20px 14px",
          borderTop: "2px solid #7c5cff",
          boxShadow: "0 -6px 24px rgba(0,0,0,0.5)",
          whiteSpace: "pre-wrap",
        });
        document.body.appendChild(bar);
      }
      const tag = `<span style="display:inline-block;padding:1px 8px;margin-right:10px;border-radius:5px;background:${label === "before" ? "#b42318" : "#0f7b3d"};color:#fff;font-weight:700;letter-spacing:.04em">${label === "before" ? "BEFORE (main 1fc46d5)" : "AFTER (fix branch)"}</span>`;
      bar.innerHTML = tag + all.map((l, i) => (i === 0 ? `<b>${l}</b>` : l)).join("<br>");
    },
    { all, label },
  );
}

// ---------------------------------------------------------------------------
// Transcript page (dark terminal look) for the API flows.
// ---------------------------------------------------------------------------
const TRANSCRIPT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>API transcript</title>
<style>
  body { margin:0; padding:28px 32px 120px; background:#0b0d12; color:#e8eaf0; font:18px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font:700 26px/1.2 -apple-system, 'Helvetica Neue', Arial, sans-serif; margin:0 0 6px; color:#fff; }
  .sub { color:#a3adc2; font:18px/1.4 -apple-system, 'Helvetica Neue', Arial, sans-serif; margin:0 0 18px; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a3040; padding:8px 12px; text-align:left; vertical-align:top; }
  th { background:#161a24; color:#cdd5e6; font-size:17px; }
  td.status { font-weight:700; white-space:nowrap; }
  td.status.ok { color:#57d38c; } td.status.deny { color:#ff6b6b; } td.status.other { color:#f5c451; }
  td.req { white-space:nowrap; } td.req .id { color:#9fb4ff; margin-right:8px; }
  td.body { color:#ffd28a; word-break:break-all; }
  tr.new td { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background:#2b2f4a; } to { background:transparent; } }
</style></head><body>
<h1 id="t">API transcript</h1><p class="sub" id="s"></p>
<table><thead><tr><th>#</th><th>Request (identity)</th><th>Status</th><th>Body (first 120 chars)</th></tr></thead><tbody id="rows"></tbody></table>
<script>
  window.__setHeader = (t, s) => { document.getElementById('t').textContent = t; document.getElementById('s').textContent = s; };
  window.__addRow = (r) => {
    const tb = document.getElementById('rows');
    const tr = document.createElement('tr'); tr.className = 'new';
    const n = tb.children.length + 1;
    const cls = typeof r.status === 'number' ? (r.status < 300 ? 'ok' : (r.status === 401 || r.status === 403) ? 'deny' : 'other') : 'other';
    tr.innerHTML = '<td>' + n + '</td><td class="req"><span class="id">' + r.who + '</span>' + r.method + ' ' + r.path + '</td>'
      + '<td class="status ' + cls + '">' + r.status + (r.location ? ' → ' + r.location : '') + '</td>'
      + '<td class="body"></td>';
    tr.lastChild.textContent = r.body || '';
    tb.appendChild(tr); tr.scrollIntoView({ block: 'nearest' });
  };
</script></body></html>`;

const transcriptPath = `${rawDir}/transcript.html`;
writeFileSync(transcriptPath, TRANSCRIPT_HTML);
const transcriptUrl = pathToFileURL(transcriptPath).href;

async function openTranscript(page, title, subtitle) {
  await page.goto(transcriptUrl, { waitUntil: "load" });
  await page.evaluate(({ title, subtitle }) => window.__setHeader(title, subtitle), { title, subtitle });
}

/** Do the request in Node (explicit Cookie header), then append the row on the page. */
async function row(page, who, cookie, path, opts = {}) {
  const r = await probe(base, path, { cookie, ...opts });
  const body = (r.body || "").slice(0, 120);
  await page.evaluate((x) => window.__addRow(x), { who, method: r.method, path, status: r.status, location: r.location, body });
  await sleep(2000);
  return r;
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------
async function newRecordingContext(browser, extra = {}) {
  return browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: SIZE },
    ...extra,
  });
}

async function finish(ctx, page, name) {
  await sleep(500);
  const video = page.video();
  await ctx.close();
  await video.saveAs(`${rawDir}/${name}.webm`);
  console.log(`recorded ${rawDir}/${name}.webm`);
}

async function clipLogin(browser) {
  const ctx = await newRecordingContext(browser);
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await caption(
    page,
    [
      "Step 1 of 4: /login, anonymous (no cookie).",
      "main: hamburger-style mark, tab title 'Switchyard — Databases'.  fix: rail-switch mark, tab title 'Sign in · Switchyard'.",
    ],
    { withTitle: true },
  );
  await sleep(4000);
  await page.getByRole("button", { name: /no account yet/i }).click();
  await sleep(400);
  const h1 = await page.locator("h1").first().innerText();
  await caption(
    page,
    [
      `Step 2 of 4: clicked "No account yet? Create one".  Heading now reads: "${h1}"`,
      "main: heading stays 'Sign in to Switchyard' in create-account mode.  fix: 'Create your Switchyard account' + mode-specific hint.",
    ],
    { withTitle: true },
  );
  await sleep(4000);
  await page.getByRole("button", { name: /already have an account/i }).click();
  await sleep(400);
  await caption(page, ["Step 3 of 4: back to sign-in; typing alice@demo.test / password-a (fake Dokploy user who owns alpha-db)."], {
    withTitle: true,
  });
  await sleep(1500);
  await page.locator('input[name="email"]').pressSequentially("alice@demo.test", { delay: TYPE_DELAY });
  await sleep(400);
  await page.locator('input[name="password"]').pressSequentially("password-a", { delay: TYPE_DELAY });
  await sleep(1200);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");
  await sleep(800);
  await caption(
    page,
    [
      "Step 4 of 4: signed in; the workspace shows alice's only service (alpha-db). Live metrics/logs are 'unavailable' here: no Docker on this machine.",
      "main: tab title 'Switchyard — Databases'.  fix: tab title 'Switchyard'.",
    ],
    { withTitle: true },
  );
  await sleep(5000);
  await finish(ctx, page, "01-login-and-create-account");
}

async function clipForged(browser) {
  const ctx = await newRecordingContext(browser);
  const page = await ctx.newPage();
  await openTranscript(
    page,
    "Forged session cookie vs. the API routes",
    "Every request below carries Cookie: switchyard_session=forged-garbage (NOT sealed with the server secret). The proxy only checks the cookie exists.",
  );
  await caption(page, [
    "P0: presence-only cookie checks on /api/agent/* and the metrics routes.",
    "main: 200 everywhere, and the forged POST sets the SHARED agent API key (row 3 shows configured:true).  fix: 401 'Not signed in' on every row.",
  ]);
  await sleep(2500);
  const who = "forged";
  const f = C.forged;
  await row(page, who, f, "/api/agent/config");
  await row(page, who, f, "/api/agent/config", { method: "POST", body: { key: "sk-ant-demo-forged-1234567890" } });
  await row(page, who, f, "/api/agent/config");
  await row(page, who, f, "/api/agent/config", { method: "POST", body: { clear: true } });
  await row(page, who, f, "/api/agent/models");
  await row(page, who, f, "/api/agent/oauth/start", { method: "POST" });
  await row(page, who, f, "/api/agent/changes");
  await row(page, who, f, "/api/services/metrics/history?app=alpha-db");
  await row(page, who, f, "/api/services/http-metrics?app=alpha-db");
  await caption(page, [
    "Done. Rows 2-3 are the key: on main a forged cookie stores an API key every user's agent will then bill against.",
    "fix: sessionFromRequest() verifies the AES-GCM seal + age on every route; forged cookies get 401.",
  ]);
  await sleep(3000);
  await finish(ctx, page, "02-forged-cookie-api");
}

async function clipCrossUser(browser) {
  const ctx = await newRecordingContext(browser);
  const page = await ctx.newPage();
  await openTranscript(
    page,
    "Cross-user service allow-list (knownAppNames cache)",
    "alice owns alpha-db, bob owns beta-db (fake Dokploy). Both cookies are valid, sealed sessions.",
  );
  await caption(page, [
    "P0: the allow-list cache is process-global with a 30 s TTL and no session key.",
    "main: bob gets alice's app (200/200/500) and is denied his OWN app (403).  fix: 403 on alice's app, 200 on his own.",
  ]);
  await sleep(4000);
  await row(page, "alice", C.alice, "/api/services/metrics?app=alpha-db");
  await caption(page, [
    "alice just primed the cache with {alpha-db}. Now bob, within the 30 s TTL:",
    "main: bob is served alice's service from alice's cached allow-list.  fix: the cache is keyed per session; bob sees only {beta-db}.",
  ]);
  await sleep(3000);
  await row(page, "bob", C.bob, "/api/services/metrics?app=alpha-db");
  await row(page, "bob", C.bob, "/api/services/http-metrics?app=alpha-db");
  await row(page, "bob", C.bob, "/api/services/logs?app=alpha-db");
  await row(page, "bob", C.bob, "/api/services/metrics?app=beta-db");
  await caption(page, [
    "Last row is bob's OWN service.  main: 403 (alice's cached list doesn't contain beta-db).  fix: 200.",
    "'event: unavailable' / 500 bodies are the Docker-less machine; the status code is the finding.",
  ]);
  await sleep(4000);
  await finish(ctx, page, "03-cross-user-allowlist");
}

async function clipExpired(browser) {
  const ctx = await newRecordingContext(browser);
  await ctx.addCookies([
    { name: "switchyard_session", value: C.expiredAlice, domain: host, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await sleep(500);
  await caption(
    page,
    [
      "Step 1 of 2: browser holds a correctly sealed alice cookie whose iat is 8 days old (SESSION_MAX_AGE = 7 days). Navigated to /.",
      "main: the workspace renders (age never checked server-side).  fix: bounced to /login (openSession rejects the stale iat).",
    ],
    { withTitle: true },
  );
  await sleep(6000);
  await openTranscript(
    page,
    "Expired session cookie vs. the API routes",
    "Same 8-day-old, correctly sealed alice cookie, sent explicitly as Cookie: switchyard_session=…",
  );
  await caption(page, [
    "Step 2 of 2: the same stale cookie against two API routes.",
    "main: 200 / 200.  fix: 401 / 401.",
  ]);
  await sleep(3500);
  await row(page, "alice (iat -8d)", C.expiredAlice, "/api/agent/config");
  await row(page, "alice (iat -8d)", C.expiredAlice, "/api/services/metrics/history?app=alpha-db");
  await caption(page, [
    "Done.  main: the cookie's Max-Age was the only expiry, so a stolen or stale cookie stays valid.",
    "fix: openSession() rejects iat older than SESSION_MAX_AGE (and implausibly future iat) on every open.",
  ]);
  await sleep(5000);
  await finish(ctx, page, "04-expired-cookie");
}

const browser = await launch();
try {
  const clips = { login: clipLogin, forged: clipForged, crossuser: clipCrossUser, expired: clipExpired };
  if (clipArg === "all") {
    for (const fn of Object.values(clips)) await fn(browser);
  } else if (clips[clipArg]) {
    await clips[clipArg](browser);
  } else {
    throw new Error(`unknown clip ${clipArg}`);
  }
} finally {
  await browser.close();
}
