import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { closeEngines } from "../src/engine/native.ts";
import { readScreen, settle } from "../src/look/read.ts";

/** Runs work against the fake engine (fixtures/fake-engine-settle.mjs) in a given mode; answers the requests it got. */
async function withFakeEngine(env: Record<string, string>, work: (udid: string) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const dir = mkdtempSync(join(tmpdir(), "settle-test-"));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const saved = { ...process.env };
  Object.assign(process.env, { SIMULATOR_USE_ENGINE: new URL("fixtures/fake-engine-settle.mjs", import.meta.url).pathname, FAKE_LOG: log, ...env });
  const udid = `FAKE-SETTLE-${Math.random().toString(36).slice(2)}`;
  try {
    await work(udid);
  } finally {
    closeEngines(udid);
    process.env = saved;
  }
  const requests = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  rmSync(dir, { recursive: true, force: true });
  return requests;
}

test("an input, the wait for the screen to hold still and the read after it are one engine request", async () => {
  const requests = await withFakeEngine({ FAKE_SETTLE: "ok" }, async (udid) => {
    const { snap, settled } = await settle(udid, "Demo", { steps: ["tap -x 201 -y 350"] });
    assert.equal(settled, true);
    assert.ok(snap.elements.some((e) => e.id === "signIn"));
  });
  assert.deepEqual(requests.map((r) => r.op), ["settle_read"]);
  assert.deepEqual(requests[0]!.input, { op: "steps", steps: [{ tap: [201, 350] }] });
  assert.equal(requests[0]!.lean, true);
});

test("an engine from before settle_read gets the input the old way, once, then its wait and a read", async () => {
  const requests = await withFakeEngine({ FAKE_SETTLE: "unknown" }, async (udid) => {
    await settle(udid, "Demo", { gesture: ["swipe", "--start-x", "350", "--start-y", "500", "--end-x", "50", "--end-y", "500", "--duration", "0.3"] });
  });
  assert.deepEqual(requests.map((r) => r.op), ["settle_read", "swipe", "settle", "describe"]);
});

test("an input that went out is never sent again when the read after it failed", async () => {
  const requests = await withFakeEngine({ FAKE_SETTLE: "failed" }, async (udid) => {
    await settle(udid, "Demo", { steps: ["tap -x 201 -y 350"] });
  });
  assert.deepEqual(requests.map((r) => r.op), ["settle_read", "settle", "describe"]);
});

test("a late look waits from the screen last read, for as long as is left", async () => {
  const requests = await withFakeEngine({ FAKE_SETTLE: "ok" }, async (udid) => {
    await settle(udid, "Demo", undefined, { firstChangeMs: 1_234, baseline: "kept" });
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.op, "settle_read");
  assert.equal(requests[0]!.input, undefined);
  assert.equal(requests[0]!.first_change_ms, 1_234);
  assert.equal(requests[0]!.baseline, "kept");
});

test("a read is given again only when asked for, and says so; ui_look's full tree asks for every attribute", async () => {
  const requests = await withFakeEngine({ FAKE_REUSED: "seed" }, async (udid) => {
    const again = await readScreen(udid, true, { reuse: true });
    assert.equal(again.reused, "seed");
    const plain = await readScreen(udid);
    assert.equal(plain.reused, undefined);
    await readScreen(udid, true, { full: true });
  });
  assert.deepEqual(requests.map((r) => [r.op, Boolean(r.reuse), Boolean(r.lean)]), [["describe", true, true], ["describe", false, true], ["describe", false, false]]);
});

test("SIMULATOR_USE_REUSE=off never asks for a read again", async () => {
  const requests = await withFakeEngine({ FAKE_REUSED: "seed", SIMULATOR_USE_REUSE: "off" }, async (udid) => {
    const again = await readScreen(udid, true, { reuse: true });
    assert.equal(again.reused, undefined);
  });
  assert.equal(requests[0]!.reuse, undefined);
});
