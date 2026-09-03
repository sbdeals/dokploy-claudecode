#!/usr/bin/env node
/**
 * Convert the raw Playwright .webm recordings to h264 .mp4 and print a
 * size/duration table (markdown) for video/README.md.
 *
 *   node convert.mjs <rawWebmRoot> <videoOutRoot> [crf=22]
 *
 * <rawWebmRoot>/{before,after}/<clip>.webm -> <videoOutRoot>/{before,after}/<clip>.mp4
 * Also extracts one check frame per clip (at ~60% of its length) into <rawWebmRoot>/frames/.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";

const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const [rawRoot, outRoot, crfArg] = process.argv.slice(2);
if (!rawRoot || !outRoot) {
  console.error("usage: convert.mjs <rawWebmRoot> <videoOutRoot> [crf]");
  process.exit(1);
}
const crf = crfArg || "22";
const CLIPS = ["01-login-and-create-account", "02-forged-cookie-api", "03-cross-user-allowlist", "04-expired-cookie"];
const SIDES = ["before", "after"];

function duration(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(String(out).trim());
}

mkdirSync(`${rawRoot}/frames`, { recursive: true });
const rows = [];
for (const side of SIDES) {
  mkdirSync(`${outRoot}/${side}`, { recursive: true });
  for (const clip of CLIPS) {
    const src = `${rawRoot}/${side}/${clip}.webm`;
    const dst = `${outRoot}/${side}/${clip}.mp4`;
    execFileSync(FFMPEG, [
      "-v", "error", "-y", "-i", src,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", crf, "-preset", "medium", "-r", "30",
      "-movflags", "+faststart", dst,
    ]);
    const secs = duration(dst);
    const mb = statSync(dst).size / (1024 * 1024);
    execFileSync(FFMPEG, ["-v", "error", "-y", "-ss", String(Math.max(1, secs * 0.6).toFixed(1)), "-i", dst, "-frames:v", "1", `${rawRoot}/frames/${side}-${clip}.png`]);
    rows.push({ side, clip, secs, mb });
    console.log(`${side}/${clip}.mp4  ${secs.toFixed(1)} s  ${mb.toFixed(2)} MB`);
  }
}
console.log("\n| Clip | Side | Duration | Size |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${r.clip}.mp4 | ${r.side} | ${r.secs.toFixed(1)} s | ${r.mb.toFixed(2)} MB |`);
