import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, metricsStoreUrl, renderContainer } from "../dist/lib.js";

test("hash is stable for identical config", () => {
  const a = renderContainer(defaultConfig("linux"), "1.0.0");
  const b = renderContainer(defaultConfig("linux"), "1.0.0");
  assert.equal(a.hash, b.hash);
});

test("hash changes when a container-relevant setting changes", () => {
  const cfg = defaultConfig("linux");
  const base = renderContainer(cfg, "1.0.0");
  assert.notEqual(base.hash, renderContainer({ ...cfg, dashboardPort: 3101 }, "1.0.0").hash);
  assert.notEqual(base.hash, renderContainer({ ...cfg, adminPassword: "pw" }, "1.0.0").hash);
  assert.notEqual(base.hash, renderContainer({ ...cfg, imageTag: "latest" }, "1.0.0").hash);
});

test("imageTag defaults to the CLI version and can be overridden", () => {
  const cfg = defaultConfig("linux");
  assert.equal(renderContainer(cfg, "9.9.9").image, "ghcr.io/sbdeals/switchyard:9.9.9");
  assert.equal(
    renderContainer({ ...cfg, imageTag: "latest" }, "9.9.9").image,
    "ghcr.io/sbdeals/switchyard:latest",
  );
});

test("expose switches the publish binding (and the hash)", () => {
  const cfg = defaultConfig("linux");
  const closed = renderContainer(cfg, "1.0.0");
  const open = renderContainer({ ...cfg, expose: true }, "1.0.0");
  assert.ok(closed.runArgs.includes("127.0.0.1:3001:3001"));
  assert.ok(open.runArgs.includes("0.0.0.0:3001:3001"));
  assert.notEqual(closed.hash, open.hash);
});

test("hostIp adds SWITCHYARD_HOST_IP and changes the hash; empty is a no-op", () => {
  const cfg = defaultConfig("linux");
  const base = renderContainer(cfg, "1.0.0");
  // Empty hostIp (the default) must not add the env or perturb the hash.
  assert.ok(!base.runArgs.some((a) => a.startsWith("SWITCHYARD_HOST_IP=")));
  const withIp = renderContainer({ ...cfg, hostIp: "203.0.113.10" }, "1.0.0");
  assert.ok(withIp.runArgs.includes("SWITCHYARD_HOST_IP=203.0.113.10"));
  assert.notEqual(base.hash, withIp.hash);
});

test("run args carry the BFF env and labels", () => {
  const cfg = { ...defaultConfig("linux"), adminEmail: "a@b.co", adminPassword: "pw" };
  const plan = renderContainer(cfg, "1.0.0");
  assert.ok(plan.runArgs.includes("DOKPLOY_EMAIL=a@b.co"));
  assert.ok(plan.runArgs.includes("DOKPLOY_PASSWORD=pw"));
  assert.ok(plan.runArgs.includes("DOKPLOY_URL=http://dokploy:3000"));
  assert.ok(plan.runArgs.includes(`switchyard.config-hash=${plan.hash}`));
  assert.equal(plan.runArgs.at(-1), plan.image);
});

test("session secret is passed to the dashboard and folds into the hash", () => {
  const cfg = { ...defaultConfig("linux"), sessionSecret: "s3cr3t" };
  const plan = renderContainer(cfg, "1.0.0");
  assert.ok(plan.runArgs.includes("SWITCHYARD_SESSION_SECRET=s3cr3t"));
  // Changing the secret must change the fingerprint so `up` recreates.
  const other = renderContainer({ ...cfg, sessionSecret: "different" }, "1.0.0");
  assert.notEqual(plan.hash, other.hash);
});

test("metrics store URL is wired into the container env and the hash", () => {
  const cfg = defaultConfig("linux");
  // No password yet → empty URL, and the env var is present-but-empty.
  assert.equal(metricsStoreUrl(cfg), "");
  const noStore = renderContainer(cfg, "1.0.0");
  assert.ok(noStore.runArgs.includes("SWITCHYARD_STORE_URL="));

  // With a password, the URL points at the store service by DNS and is hashed.
  const withPw = { ...cfg, storePassword: "s3cret" };
  const url = metricsStoreUrl(withPw);
  assert.match(url, /^postgresql:\/\/switchyard:s3cret@switchyard-metrics:5432\/switchyard$/);
  const plan = renderContainer(withPw, "1.0.0");
  assert.ok(plan.runArgs.includes(`SWITCHYARD_STORE_URL=${url}`));
  assert.notEqual(noStore.hash, plan.hash);
});

test("disabling the store blanks the URL", () => {
  const cfg = { ...defaultConfig("linux"), store: false, storePassword: "s3cret" };
  assert.equal(metricsStoreUrl(cfg), "");
});

test("assumeHttps adds SWITCHYARD_ASSUME_HTTPS=1 and changes the hash; off is a no-op", () => {
  const cfg = defaultConfig("linux");
  const base = renderContainer(cfg, "1.0.0");
  // Off (the default) must not add the env or perturb the hash of existing installs.
  assert.ok(!base.runArgs.some((a) => a.startsWith("SWITCHYARD_ASSUME_HTTPS=")));
  const on = renderContainer({ ...cfg, assumeHttps: true }, "1.0.0");
  assert.ok(on.runArgs.includes("SWITCHYARD_ASSUME_HTTPS=1"));
  assert.notEqual(base.hash, on.hash);
});
