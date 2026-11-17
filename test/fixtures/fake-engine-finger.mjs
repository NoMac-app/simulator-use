#!/usr/bin/env node
// A stand-in engine for the held finger (ui-act's holdSlider): every request is appended to FAKE_ENGINE_LOG, one JSON
// line each, across the engines a test starts. The first drag of all is answered as FAKE_FIRST_DRAG says: "partial"
// (failed after some of it went out), "exit" (the engine stops with it unanswered) or ok; a lift alone (steps 0) as
// FAKE_LIFT says: "fail" or ok. A point read answers FAKE_VALUE as the slider's value.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_ENGINE_LOG;
const drags = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"op":"drag"')).length : 0);
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const first = request.op === "drag" && drags() === 0;
  appendFileSync(log, line + "\n");
  let answer = { ok: true };
  if (first && process.env.FAKE_FIRST_DRAG === "exit") process.exit(0);
  if (first && process.env.FAKE_FIRST_DRAG === "partial") answer = { ok: false, error: "Input stopped", input_sent: true };
  if (request.op === "drag" && request.steps === 0 && process.env.FAKE_LIFT === "fail") answer = { ok: false, error: "the lift failed" };
  if (request.op === "point") answer = { ok: true, element: { AXValue: process.env.FAKE_VALUE ?? "0.5" } };
  process.stdout.write(JSON.stringify(answer) + "\n");
}
