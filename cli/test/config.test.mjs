import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { coerceConfigValue, configPath, loadConfig, saveConfig } from "../dist/lib.js";

function withTempConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-test-"));
  const file = join(dir, "config.json");
  const prev = process.env.SWITCHYARD_CONFIG;
  process.env.SWITCHYARD_CONFIG = file;
  try {
    return fn(file);
  } finally {
    if (prev === undefined) delete process.env.SWITCHYARD_CONFIG;
    else process.env.SWITCHYARD_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("SWITCHYARD_CONFIG override + save/load roundtrip", () => {
  withTempConfig((file) => {
    assert.equal(configPath(), file);
    const first = loadConfig();
    assert.equal(first.existed, false);
    assert.equal(first.config.dashboardPort, 3001);

    saveConfig({ ...first.config, dashboardPort: 3101, adminEmail: "x@y.zz" }, file);
    const second = loadConfig();
    assert.equal(second.existed, true);
    assert.equal(second.config.dashboardPort, 3101);
    assert.equal(second.config.adminEmail, "x@y.zz");
  });
});

test("configs written by older CLIs gain new defaults", () => {
  withTempConfig((file) => {
    writeFileSync(file, JSON.stringify({ dashboardPort: 4000 }), "utf8");
    const { config } = loadConfig();
    assert.equal(config.dashboardPort, 4000);
    assert.equal(config.dokployPort, 3000); // default filled in
    assert.equal(config.image, "ghcr.io/sbdeals/switchyard");
    assert.equal(config.assumeHttps, false); // added after 0.1.3; off for existing installs
  });
});

test("invalid JSON is a user error, not a crash", () => {
  withTempConfig((file) => {
    writeFileSync(file, "{ not json", "utf8");
    assert.throws(() => loadConfig(), /not valid JSON/);
  });
});

test("coerceConfigValue types and errors", () => {
  assert.equal(coerceConfigValue("dashboardPort", "3101"), 3101);
  assert.equal(coerceConfigValue("expose", "true"), true);
  assert.equal(coerceConfigValue("expose", "0"), false);
  assert.equal(coerceConfigValue("assumeHttps", "true"), true);
  assert.equal(coerceConfigValue("assumeHttps", "false"), false);
  assert.equal(coerceConfigValue("adminEmail", "a@b.co"), "a@b.co");
  assert.throws(() => coerceConfigValue("dashboardPort", "abc"), /integer/);
  assert.throws(() => coerceConfigValue("expose", "maybe"), /true or false/);
});
