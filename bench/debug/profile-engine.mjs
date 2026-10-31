#!/usr/bin/env node
// Where the time of a tap, a fill and a read goes, measured on the engine itself (no MCP server in between).
//   node bench/debug/profile-engine.mjs ENGINE_PATH UDID [out.json]
// Needs the demo app (dev.simtap.demo) installed. Nothing else may hold an engine on the phone.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [enginePath, udid, outFile] = process.argv.slice(2);
if (!enginePath || !udid) { console.error("usage: profile-engine.mjs ENGINE UDID [out.json]"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const BUNDLE = "dev.simtap.demo";
const reset = async () => {
  try { execFileSync("xcrun", ["simctl", "terminate", udid, BUNDLE], { stdio: "ignore" }); } catch {}
  execFileSync("xcrun", ["simctl", "launch", udid, BUNDLE], { stdio: "ignore" });
  await sleep(2500);
};

const child = spawn(enginePath, ["--udid", udid], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const t0 = now();
const ready = JSON.parse((await lines.next()).value);
console.log("ready", JSON.stringify(ready), `${(now() - t0).toFixed(0)} ms`);
let queue = Promise.resolve();
const call = (req) => {
  const p = queue.then(async () => {
    const start = now();
    child.stdin.write(`${JSON.stringify(req)}\n`);
    const line = (await lines.next()).value;
    return { answer: JSON.parse(line), rtt: now() - start, bytes: line.length };
  });
  queue = p.catch(() => undefined);
  return p;
};
const out = { ready, runs: {} };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: +s[0]?.toFixed(1), median: +s[Math.floor(s.length / 2)]?.toFixed(1), max: +s.at(-1)?.toFixed(1) }; };
const walk = (nodes, f) => { for (const n of [nodes].flat()) { f(n); walk(n.children ?? [], f); } };
const find = (tree, id) => { let hit; walk(tree, (n) => { if (n.AXUniqueId === id) hit = n; }); return hit; };

await reset();
await call({ op: "describe" }); // first read after a launch: accessibility load
// 1. Whole-screen reads: the default keys, and only what simulator-use's snapshot uses.
for (const [name, extra] of [["describe", {}], ["describe-min", { keys: ["label", "frameDict", "value", "uniqueID", "type", "role", "roleDescription", "subrole", "enabled", "pid"] }], ["describe-noweb", { web: false }]]) {
  const rtt = [], ms = [], ser = [], bytes = [], parse = [];
  for (let i = 0; i < 10; i++) {
    const r = await call({ op: "describe", ...extra });
    if (!r.answer.ok) { console.log(name, "failed", r.answer.error); break; }
    rtt.push(r.rtt); ms.push(r.answer.ms); ser.push(...(r.answer.serialize_ms ?? [])); bytes.push(r.bytes);
  }
  out.runs[name] = { rtt: stats(rtt), engineMs: stats(ms), serializeMs: stats(ser), bytes: stats(bytes) };
  console.log(name, JSON.stringify(out.runs[name]));
}
// 2. A point read on the Email field.
{
  const rtt = [];
  for (let i = 0; i < 10; i++) rtt.push((await call({ op: "point", x: 201, y: 194 })).rtt);
  out.runs.point = { rtt: stats(rtt) };
  console.log("point", JSON.stringify(out.runs.point));
}
// 3. When the screen changes after a tap on Sign In (empty fields: "Invalid email or password"), and when the tree does.
{
  const traces = [];
  for (let i = 0; i < 4; i++) {
    await reset();
    await call({ op: "describe" });
    const r = await call({ op: "tap_trace", x: 201, y: 350, window_ms: 1500 });
    traces.push(r.answer.changes);
  }
  out.runs.tapTrace = traces;
  console.log("tap_trace (ms after the tap of each screen change)", JSON.stringify(traces));
  const treeSeen = [];
  for (let i = 0; i < 4; i++) {
    await reset();
    await call({ op: "describe" });
    const start = now();
    await call({ op: "tap", x: 201, y: 350 });
    for (;;) {
      const r = await call({ op: "describe" });
      const status = find(r.answer.tree, "status");
      if (status && /Invalid/.test(status.AXLabel ?? "")) { treeSeen.push(now() - start); break; }
      if (now() - start > 3000) { treeSeen.push(-1); break; }
    }
  }
  out.runs.tapTreeChange = treeSeen;
  console.log("tap: the tree shows the change after (ms)", JSON.stringify(treeSeen.map((x) => +x.toFixed(0))));
  // The settle the MCP server asks for, after a tap.
  const settles = [];
  for (let i = 0; i < 4; i++) {
    await reset();
    await call({ op: "describe" });
    await call({ op: "tap", x: 201, y: 350 });
    const s = await call({ op: "settle", first_change_ms: 800, quiet_ms: 150, timeout_ms: 4000 });
    settles.push({ waited: s.answer.waited_ms, updates: s.answer.updates, rtt: +s.rtt.toFixed(0) });
  }
  out.runs.tapSettle = settles;
  console.log("tap then settle", JSON.stringify(settles));
}
// 4. A fill: tap the field, select all, delete, type; then when the text lands in the field.
{
  const fills = [];
  for (let i = 0; i < 4; i++) {
    await reset();
    await call({ op: "describe" });
    const keys = [];
    for (const c of "gary@example.com") keys.push({ type: c });
    const start = now();
    const sent = await call({ op: "steps", steps: [{ tap: [201, 194] }, { sleep: 0.15 }, { combo: { mods: [227], key: 4 } }, { key: 42 }, { type: "gary@example.com" }] });
    const sentAt = now() - start;
    const seen = [];
    let value = "";
    for (;;) {
      const r = await call({ op: "point", x: 201, y: 194 });
      const v = String(r.answer.element?.AXValue ?? "");
      if (v !== value) { seen.push([+(now() - start).toFixed(0), v.length]); value = v; }
      if (v === "gary@example.com" || now() - start > 5000) break;
    }
    const trace = await call({ op: "settle", first_change_ms: 0, quiet_ms: 150, timeout_ms: 4000 });
    fills.push({ sentMs: +sentAt.toFixed(0), engineStepsMs: sent.answer.ms, valueTimeline: seen, doneMs: +(now() - start).toFixed(0), quietAfterMs: trace.answer.waited_ms });
  }
  out.runs.fill = fills;
  console.log("fill", JSON.stringify(fills, null, 0));
}
// 5. The keyboard: does an on-screen keyboard come up (it changes how long iOS takes per key)?
{
  await reset();
  await call({ op: "steps", steps: [{ tap: [201, 194] }] });
  await sleep(1200);
  const r = await call({ op: "describe" });
  let keyboard = false;
  walk(r.answer.tree, (n) => { if (["inputView", "UIKeyboardLayoutStar Preview", "SystemInputAssistantView"].includes(n.AXUniqueId)) keyboard = true; });
  out.runs.keyboardShown = keyboard;
  console.log("on-screen keyboard after a tap on a field:", keyboard);
}
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 1));
child.stdin.end();
await sleep(1500);
process.exit(0);
