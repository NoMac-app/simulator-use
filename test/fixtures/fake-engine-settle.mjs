#!/usr/bin/env node
// A stand-in engine for settle's tests: every request is logged to FAKE_LOG (one JSON line each); describe answers
// with the sign-in screen (reused: FAKE_REUSED when asked to reuse); settle_read as FAKE_SETTLE says: "ok" (the
// screen after the input), "unknown" (an engine from before settle_read), "failed" (an error after its input went out),
// "dies" (the engine stops once it has the request).
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const tree = JSON.parse(readFileSync(new URL("login.json", import.meta.url), "utf8"));
const log = (request) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(request)}\n`);
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log(request);
  let answer = { ok: true };
  if (request.op === "describe") answer = { ok: true, tree, ...(request.reuse && process.env.FAKE_REUSED ? { reused: process.env.FAKE_REUSED } : {}) };
  else if (request.op === "settle_read") {
    const mode = process.env.FAKE_SETTLE ?? "ok";
    // An engine from before settle_read says only that (no input_sent); "dies" stops without answering.
    if (mode === "dies") process.exit(1);
    answer = mode === "unknown" ? { ok: false, error: "unknown op settle_read" }
      : mode === "failed" ? { ok: false, error: "No translation object returned for simulator", input_sent: true }
      : { ok: true, tree, settled: true, changed: true, reads: 1, dropped: 0, read_ms: [5], first_change_ms: 10 };
  } else if (request.op === "settle") answer = { ok: true, settled: true, waited_ms: 5, updates: 1 };
  process.stdout.write(JSON.stringify(answer) + "\n");
}
