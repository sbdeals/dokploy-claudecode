#!/usr/bin/env node
/**
 * Browser screenshots for the UI findings (playwright-core + cached Chromium).
 *
 *   node capture.mjs pages  <dashboardBase> <outDir>   # 01 login, 02 signup, 03 workspace, 11 secure cookie  (stub UP)
 *   node capture.mjs error  <dashboardBase> <outDir>   # 04 "Couldn't reach Dokploy" card                     (stub DOWN)
 *
 * Writes NN-*.png plus 00-titles.md (document.title per page) and 11-secure-cookie.md.
 * env: SWITCHYARD_SESSION_SECRET (default demo-secret-do-not-use), PW_DIR, CHROME_PATH
 */
import { cookies, launch, writeText } from "./lib.mjs";

const [mode, base, outDir] = process.argv.slice(2);
if (!mode || !base || !outDir) {
  console.error("usage: capture.mjs <pages|error> <dashboardBase> <outDir>");
  process.exit(1);
}
const C = cookies();
const url = new URL(base);
const VIEWPORT = { width: 1280, height: 800 };

async function newContext(browser, extra = {}) {
  return browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, ...extra });
}

async function setSession(ctx, value) {
  await ctx.addCookies([
    { name: "switchyard_session", value, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function login(page, email, password) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");
}

async function pages(browser) {
  const titles = [];

  // 01 / 02: the login screen in both modes.
  let ctx = await newContext(browser);
  let page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  titles.push({ path: "/login (sign-in mode)", title: await page.title(), h1: await page.locator("h1").first().innerText() });
  await page.screenshot({ path: `${outDir}/01-login-signin.png` });
  await page.getByRole("button", { name: /no account yet/i }).click();
  await page.waitForTimeout(300);
  titles.push({ path: "/login (create-account mode)", title: await page.title(), h1: await page.locator("h1").first().innerText() });
  await page.screenshot({ path: `${outDir}/02-login-signup.png` });
  await ctx.close();

  // 03: real sign-in as alice through the form, landing on the workspace.
  ctx = await newContext(browser);
  page = await ctx.newPage();
  await login(page, "alice@demo.test", "password-a");
  await page.waitForTimeout(1500);
  titles.push({ path: "/ (workspace, signed in as alice)", title: await page.title(), h1: "" });
  await page.screenshot({ path: `${outDir}/03-workspace-alice.png` });
  const plainCookie = (await ctx.cookies()).find((c) => c.name === "switchyard_session");
  await ctx.close();

  // 11: same sign-in but the request arrives "behind an HTTPS proxy".
  ctx = await newContext(browser, { extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
  page = await ctx.newPage();
  await login(page, "alice@demo.test", "password-a");
  const proxiedCookie = (await ctx.cookies()).find((c) => c.name === "switchyard_session");
  await ctx.close();

  const cookieRow = (label, c) =>
    `| ${label} | ${c ? "yes" : "no"} | ${c ? c.secure : ""} | ${c ? c.httpOnly : ""} | ${c ? c.sameSite : ""} |`;
  writeText(
    `${outDir}/11-secure-cookie.md`,
    [
      "# P1: session cookie never marked Secure",
      "",
      `Signed in as alice through the real form, then read the cookie jar. Captured ${new Date().toISOString()} against ${base}.`,
      "",
      "| Sign-in over | cookie set | secure | httpOnly | sameSite |",
      "|---|---|---|---|---|",
      cookieRow("plain HTTP (localhost default)", plainCookie),
      cookieRow("HTTP with `X-Forwarded-Proto: https` (behind an HTTPS proxy, e.g. `--expose` + TLS terminator)", proxiedCookie),
      "",
      "Expected: plain HTTP stays `secure=false` (the cookie must still work on http://127.0.0.1). Behind an HTTPS proxy the fix sets `secure=true` so the browser never sends the session over clear HTTP.",
      "",
    ].join("\n"),
  );

  writeText(
    `${outDir}/00-titles.md`,
    [
      "# Page titles and headings",
      "",
      `Captured ${new Date().toISOString()} against ${base}.`,
      "",
      "| Page | document.title | first h1 |",
      "|---|---|---|",
      ...titles.map((t) => `| ${t.path} | \`${t.title}\` | ${t.h1 ? `\`${t.h1}\`` : ""} |`),
      "",
    ].join("\n"),
  );
  console.log(`wrote 01/02/03 PNGs, 00-titles.md, 11-secure-cookie.md into ${outDir}`);
}

async function error(browser) {
  const ctx = await newContext(browser);
  await setSession(ctx, C.alice);
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.getByText(/couldn.t reach dokploy/i).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${outDir}/04-error-card.png` });
  const copy = await page.locator("main, body").first().innerText();
  writeText(
    `${outDir}/04-error-card.md`,
    [
      "# P2: workspace error copy cites DOKPLOY_EMAIL / DOKPLOY_PASSWORD as UI auth",
      "",
      `Valid alice session, fake Dokploy stopped. Captured ${new Date().toISOString()} against ${base}.`,
      "",
      "```",
      copy.trim().slice(0, 1200),
      "```",
      "",
    ].join("\n"),
  );
  await ctx.close();
  console.log(`wrote 04-error-card.png/.md into ${outDir}`);
}

const browser = await launch();
try {
  if (mode === "pages") await pages(browser);
  else if (mode === "error") await error(browser);
  else throw new Error(`unknown mode ${mode}`);
} finally {
  await browser.close();
}
