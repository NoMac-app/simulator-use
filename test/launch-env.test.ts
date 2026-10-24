import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deviceEnv, deviceTimeZone, setDeviceEnv, setDeviceTimeZone } from "../src/engine/state.ts";
import { launchEnv } from "../src/tools/app-run.ts";

test("app_run's env: KEY=VALUE pairs, checked; \"\" clears; left out keeps what the device had", () => {
  assert.deepEqual(launchEnv("API_URL=http://127.0.0.1:20199 MODE=test"), { API_URL: "http://127.0.0.1:20199", MODE: "test" });
  assert.deepEqual(launchEnv(""), {});
  assert.equal(launchEnv(undefined), undefined);
  for (const bad of ["API URL=x", "1KEY=x", "=x", "KEY", 42]) assert.throws(() => launchEnv(bad), Error, String(bad));
  assert.throws(() => launchEnv(Array.from({ length: 21 }, (_, i) => `K${i}=v`).join(" ")), /up to 20/);
});

test("a device keeps its apps' environment beside its time zone, each set without the other", async () => {
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-env-"));
  const udid = "5E55E550-0000-4000-8000-000000000001";
  try {
    await setDeviceTimeZone(udid, "Asia/Tokyo");
    await setDeviceEnv(udid, { API_URL: "http://127.0.0.1:20199" });
    assert.equal(await deviceTimeZone(udid), "Asia/Tokyo");
    assert.deepEqual(await deviceEnv(udid), { API_URL: "http://127.0.0.1:20199" });
    await setDeviceTimeZone(udid, undefined);
    assert.deepEqual(await deviceEnv(udid), { API_URL: "http://127.0.0.1:20199" });
    await setDeviceEnv(udid, {});
    assert.deepEqual(await deviceEnv(udid), {});
  } finally {
    delete process.env.SIMULATOR_USE_STATE_DIR;
  }
});
