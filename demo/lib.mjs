/**
 * Shared helpers for the demo scripts: session-cookie minting, HTTP probes
 * (with SSE-aware short reads), markdown tables, and HTML -> PNG rendering via
 * playwright-core + the locally cached Chromium.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { seal } from "./mint-cookie.mjs";

export { seal };

export const SECRET = process.env.SWITCHYARD_SESSION_SECRET || "demo-secret-do-not-use";
export const PW_DIR = process.env.PW_DIR || "/Users/eliyumn/.claude/jobs/b0cd646f/tmp/demo/pw";
export const CHROME =
  process.env.CHROME_PATH ||
  "/Users/eliyumn/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const DAY = 24 * 60 * 60_000;

/** The four cookies every finding uses. */
export function cookies(now = Date.now()) {
  return {
    alice: seal(SECRET, { dokployCookie: "better-auth.session_token=alice", email: "alice@demo.test", iat: now }),
    bob: seal(SECRET, { dokployCookie: "better-auth.session_token=bob", email: "bob@demo.test", iat: now }),
    expiredAlice: seal(SECRET, {
      dokployCookie: "better-auth.session_token=alice",
      email: "alice@demo.test",
      iat: now - 8 * DAY,
    }),
    forged: "forged-garbage",
  };
}

/**
 * Probe one endpoint. Redirects are NOT followed (a 307 to /login is the
 * observation). For streaming routes the body read is bounded: we take the
 * first chunk (or give up after `readMs`) and abort.
 */
export async function probe(base, path, { method = "GET", cookie, body, headers = {}, readMs = 2500 } = {}) {
  const ctl = new AbortController();
  const h = { ...headers };
  if (cookie !== undefined) h.Cookie = `switchyard_session=${cookie}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: ctl.signal,
    });
  } catch (e) {
    return { method, path, status: "ERR", body: String(e?.message ?? e), location: null };
  }
  const location = res.headers.get("location");
  let text = "";
  try {
    const reader = res.body?.getReader();
    if (reader) {
      const timer = setTimeout(() => ctl.abort(), readMs);
      try {
        const { value } = await reader.read();
        text = value ? new TextDecoder().decode(value) : "";
        // Non-streaming responses: drain the rest quickly.
        if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
          for (;;) {
            const { value: v, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(v);
          }
        }
      } catch {
        /* aborted after the first chunk: fine */
      } finally {
        clearTimeout(timer);
        ctl.abort();
      }
    }
  } catch {
    /* ignore */
  }
  return { method, path, status: res.status, body: text.replace(/\s+/g, " ").trim().slice(0, 200), location };
}

/** Markdown table for a list of probe results (+ optional per-row note). */
export function resultsTable(rows) {
  const head = "| # | Request | Status | Location | Body (first 200 chars) |\n|---|---|---|---|---|";
  const lines = rows.map((r, i) => {
    const req = `\`${r.method} ${r.path}\`${r.note ? ` ${r.note}` : ""}`;
    const body = r.body ? `\`${r.body.replace(/\|/g, "\\|").replace(/`/g, "'")}\`` : "";
    return `| ${i + 1} | ${req} | **${r.status}** | ${r.location ?? ""} | ${body} |`;
  });
  return [head, ...lines].join("\n");
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Launch the cached Chromium through playwright-core. */
export async function launch() {
  const require = createRequire(PW_DIR + "/package.json");
  const { chromium } = require("playwright-core");
  try {
    return await chromium.launch({ executablePath: CHROME, headless: true });
  } catch (e) {
    console.warn("cached chromium failed, falling back to Google Chrome:", e?.message);
    return chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
  }
}

/** Render a markdown-ish transcript as a styled HTML page and screenshot it. */
export async function renderPng(browser, { title, subtitle, markdown }, outPath) {
  const html = transcriptHtml(title, subtitle, markdown);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
  await ctx.close();
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal markdown -> HTML: headings, paragraphs, pipe tables, code fences, inline code/bold. */
function mdToHtml(md) {
  const out = [];
  const lines = md.split("\n");
  let i = 0;
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.slice(1, r.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/).map((c) => c.trim());
      const header = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(
        `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c.replace(/\\\|/g, "|"))}</td>`).join("")}</tr>`)
            .join("") +
          "</tbody></table>",
      );
      continue;
    }
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("|") && !lines[i].startsWith("```") && !/^#{1,3}\s/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

function transcriptHtml(title, subtitle, markdown) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 32px 40px; background: #0f1115; color: #e6e6e6; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #fff; font-family: ui-sans-serif, system-ui, sans-serif; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #9fb4ff; font-family: ui-sans-serif, system-ui, sans-serif; }
  h3 { font-size: 14px; margin: 16px 0 6px; color: #c6d0ff; }
  .sub { color: #9aa3b2; margin: 0 0 18px; font-family: ui-sans-serif, system-ui, sans-serif; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
  th, td { border: 1px solid #2a2f3a; padding: 6px 10px; text-align: left; vertical-align: top; font-size: 12.5px; word-break: break-word; }
  th { background: #1a1e27; color: #cfd6e4; }
  td:nth-child(3) { white-space: nowrap; }
  code { background: #1a1e27; padding: 1px 5px; border-radius: 4px; color: #ffd28a; }
  b { color: #fff; }
  pre { background: #161a22; border: 1px solid #2a2f3a; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; font-size: 12px; }
  p { color: #c9cfda; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
${mdToHtml(markdown)}
</body></html>`;
}
