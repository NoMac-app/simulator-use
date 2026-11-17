// set's finger held on a slider (holdSlider), against a stand-in engine that logs every request: the finger is lifted
// after any move that may have gone out, by an up alone, and a failed lift never hides the move's own error.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { closeEngines } from "../src/engine/native.ts";
import type { Element } from "../src/look/snapshot.ts";
import { holdSlider } from "../src/tools/ui-act.ts";

// EdgeLab's volume slider at 30%: the thumb at x 134, 75% at x 284.
const slider: Element = { kind: "slider", id: "volume", label: "Volume", value: "0.3", x: 201, y: 239, frame: { x: 20, y: 220, width: 362, height: 38 } };
const FAKE = new URL("fixtures/fake-engine-finger.mjs", import.meta.url).pathname;

async function holdWith(udid: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "su-finger-"));
  const vars = { SIMULATOR_USE_ENGINE: FAKE, FAKE_ENGINE_LOG: join(dir, "requests.jsonl"), ...env };
  Object.assign(process.env, vars);
  try {
    const outcome = await holdSlider(udid, slider, 30, 75).then(
      (held) => ({ held, error: undefined }),
      (error: Error) => ({ held: undefined, error }),
    );
    const requests = readFileSync(vars.FAKE_ENGINE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { ...outcome, drags: requests.filter((r) => r.op === "drag") };
  } finally {
    closeEngines();
    for (const name of Object.keys(vars)) delete process.env[name];
    rmSync(dir, { recursive: true, force: true });
  }
}

const isLift = (r: Record<string, unknown> | undefined) => r?.steps === 0 && r.down === false && r.up === true;

test("set: the finger goes down on the thumb, moves, and is lifted by an up alone where it ended", async () => {
  const { held, error, drags } = await holdWith("FINGER-OK", { FAKE_VALUE: "0.75" });
  assert.equal(error, undefined);
  assert.equal(held, true);
  assert.equal(drags.length, 2, JSON.stringify(drags));
  assert.deepEqual([drags[0]!.x1, drags[0]!.x2, drags[0]!.down, drags[0]!.up], [134, 284, true, false]);
  assert.ok(isLift(drags[1]), `the lift is an up alone, no move before it (steps 0): ${JSON.stringify(drags[1])}`);
  assert.deepEqual([drags[1]!.x1, drags[1]!.y1], [284, 239]);
});

test("set: a first move that failed after part of it went out still has the finger lifted, and its error is the one thrown", async () => {
  const { error, drags } = await holdWith("FINGER-PARTIAL", { FAKE_FIRST_DRAG: "partial" });
  assert.match(String(error?.message), /finger's move may have reached the Simulator only in part: Input stopped/);
  assert.equal(drags.length, 2, JSON.stringify(drags));
  assert.ok(isLift(drags[1]), `lifted by an up alone after the failed move: ${JSON.stringify(drags[1])}`);
});

test("set: a first move whose engine stopped (lost) still has the finger lifted", async () => {
  const { error, drags } = await holdWith("FINGER-LOST", { FAKE_FIRST_DRAG: "exit" });
  assert.match(String(error?.message), /only in part: the engine stopped/);
  assert.equal(drags.length, 2, JSON.stringify(drags));
  assert.ok(isLift(drags[1]), `lifted by an up alone after the lost move: ${JSON.stringify(drags[1])}`);
});

test("set: a lift that fails too never hides the move's error; after a good move its own error is thrown", async () => {
  const both = await holdWith("FINGER-BOTH", { FAKE_FIRST_DRAG: "partial", FAKE_LIFT: "fail" });
  assert.match(String(both.error?.message), /only in part: Input stopped/);
  assert.ok(isLift(both.drags[1]));
  const liftOnly = await holdWith("FINGER-LIFT", { FAKE_VALUE: "0.75", FAKE_LIFT: "fail" });
  assert.match(String(liftOnly.error?.message), /finger's lift: the lift failed/);
});
