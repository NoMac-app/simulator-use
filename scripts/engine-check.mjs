#!/usr/bin/env node
// Fails when the engine reads on the slow path: every read paying an automation session of its own (about a second
// each, FBSimulatorControl's default), which the engine's bootstrap hook is there to prevent. On a booted phone with
// an app open, it starts the engine, reads the whole screen once to warm up, then reads it 10 more times and reads 10
// points, and checks that the engine says it reads on its own path (not "per-call"), opened no session for the
// steady reads, and read fast. Run by scripts/lab.sh; the engine's own flag shows it failing:
//   node scripts/engine-check.mjs UDID                               # passes on a working engine
//   node scripts/engine-check.mjs UDID -- --bootstrap-every-call     # fails: the slow path
//   node scripts/engine-check.mjs UDID --set PATH                    # a phone in another device set
// SIMULATOR_USE_ENGINE picks another engine build; SIMULATOR_USE_ENGINE_READS picks its read path (axe; any other
// value, or none, is the engine's default, session).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const udid = args.shift();
// --set PATH: the phone's device set (a folder), passed to the engine as its own --set.
const hasSet = args[0] === "--set";
const set = hasSet ? (args.shift(), args.shift()) : undefined;
const [dashes, ...extra] = args;
if (!udid || udid.startsWith("-") || (args.length && dashes !== "--") || (hasSet && !set)) {
  console.error("usage: node scripts/engine-check.mjs UDID [--set PATH] [-- engine arguments]");
  process.exit(2);
}
const engine = process.env.SIMULATOR_USE_ENGINE || fileURLToPath(new URL("../vendor/axe/simulator-use-engine", import.meta.url));
if (engine === "off" || engine === "0") {
  console.log("no engine: SIMULATOR_USE_ENGINE turns it off, so every read is AXe's, one process each");
  process.exit(1);
}
if (!existsSync(engine)) {
  console.error(`no engine at ${engine}: npm run native`);
  process.exit(2);
}
/** A whole-screen read on the fast path is 0.1 to 0.6 s; one that opens a session of its own takes a second or more. */
const READ_MEDIAN_MS = 900;
/** A point read is a few milliseconds on the fast path. */
const POINT_MEDIAN_MS = 250;

const child = spawn(engine, ["--udid", udid, ...(set ? ["--set", set] : []), ...extra], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async (ms) => {
  let timer;
  try {
    const line = await Promise.race([lines.next(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))]);
    if (line.done) throw new Error("the engine stopped");
    return JSON.parse(line.value);
  } finally {
    clearTimeout(timer);
  }
};
let id = 0;
const call = async (request, ms = 60_000) => {
  child.stdin.write(`${JSON.stringify({ id: ++id, ...request })}\n`);
  const answer = await next(ms);
  if (!answer.ok) throw new Error(`${request.op}: ${answer.error}`);
  return answer;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const problems = [];
try {
  const ready = await next(30_000);
  if (!ready.ready) throw new Error(`the engine did not start: ${ready.error}`);
  // The engine reads on the axe path only when asked for it by name; any other value is its default, session.
  const expected = process.env.SIMULATOR_USE_ENGINE_READS === "axe" ? "axe" : "session";
  if (ready.reads !== expected) problems.push(`the engine reads on the "${ready.reads}" path, not "${expected}"`);
  const warm = await call({ op: "describe", lean: true });
  const reads = [];
  let last = warm;
  for (let i = 0; i < 10; i++) {
    last = await call({ op: "describe", lean: true });
    reads.push(last.ms);
  }
  const center = (() => {
    const tree = Array.isArray(last.tree) ? last.tree[0] : last.tree;
    const f = tree?.frame ?? { x: 0, y: 0, width: 400, height: 800 };
    return { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) };
  })();
  const points = [];
  for (let i = 0; i < 10; i++) points.push((await call({ op: "point", x: center.x, y: center.y + (i - 5) * 20 })).ms);
  const after = await call({ op: "describe", lean: true });
  const sessions = (after.sessions ?? 0) - (warm.sessions ?? 0);
  if (sessions > 0) problems.push(`${sessions} automation session(s) opened for 21 steady reads`);
  if (median(reads) > READ_MEDIAN_MS) problems.push(`whole-screen reads took ${median(reads)} ms (median), over ${READ_MEDIAN_MS}`);
  if (median(points) > POINT_MEDIAN_MS) problems.push(`point reads took ${median(points)} ms (median), over ${POINT_MEDIAN_MS}`);
  const input = ready.hid_choice ? `${ready.hid} (${ready.hid_choice}${ready.dtuhidd ? ", dtuhidd runs" : ""})` : ready.hid;
  const summary = `reads: ${ready.reads}, hid: ${input}, first read ${warm.ms} ms, whole screen ${median(reads)} ms, point ${median(points)} ms (medians of 10), sessions opened ${warm.sessions} then ${sessions}`;
  if (problems.length) {
    console.log(`SLOW PATH: ${problems.join("; ")}\n${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`fast path: ${summary}`);
  }
} catch (error) {
  console.log(`FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 3_000).unref();
}
