#!/usr/bin/env node
// The hard cases of acting and waiting, on examples/edge-lab through simulator-use's MCP server: an answer that comes
// late, a navigation push, an alert, the keyboard, a screen that never holds still, a fill read back, a scroll, and a
// screen changed from outside between two calls. Each case runs --times times after a fresh app start; every answer
// is checked, nothing is retried, and every call is kept.
//   node bench/hard.mjs --bin ~/bench-tools/bin/simulator-use --udid $UDID --out results/x/hard.json [--times 5]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { McpClient } from "./lib/mcp.mjs";
import { median, p90 } from "./lib/measure.mjs";
import { sleep } from "./lib/sim.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const bin = arg("bin"), udid = arg("udid"), out = arg("out"), times = Number(arg("times", 5)), only = arg("only");
if (!bin || !udid || !out) { console.error("usage: hard.mjs --bin PATH --udid UDID --out FILE [--times N] [--only case,case]"); process.exit(2); }
const APP = "dev.simtap.edgelab";
const simctl = (...args) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const relaunch = async () => {
  try { simctl("terminate", udid, APP); } catch {}
  simctl("launch", udid, APP);
  await sleep(2500);
};

const mcp = new McpClient({ command: bin, args: ["mcp"], name: "simulator-use", stderrFile: `${out}.stderr.log` });
await mcp.initialize(180_000);
await mcp.listTools(60_000);
const call = async (name, args) => {
  const r = await mcp.call(name, args, 120_000);
  return { name, args, ms: r.ms, isError: r.isError, text: (r.content ?? []).map((c) => c.text ?? "").join("\n") };
};
const act = (...steps) => call("ui_act", { steps });
const look = () => call("ui_look", {});
await call("device_use", { device: udid });

/** Each case: setup (untimed), then the timed call(s) and a check of what they said. */
const cases = {
  // The tap's only effect comes 0.5, 1 or 1.5 s later: it must still be reported as a change.
  ...Object.fromEntries([["late05", "0.5"], ["late10", "1.0"], ["late15", "1.5"]].map(([id, s]) => [`late-${s}`, async () => {
    await relaunch();
    await act("tap More", "tap Timing");
    const a = await act(`tap #${id}`);
    return { calls: [a], ok: !a.isError && a.text.includes(`Done after ${s} s`), timed: a.ms };
  }])),
  // A navigation push and back: the answer is the new screen, after its animation.
  push: async () => {
    await relaunch();
    await act("tap More", "tap Timing");
    const a = await act("tap #push");
    const b = await act("back");
    const ok = !a.isError && /^screen:/m.test(a.text) && /Detail page/.test(a.text) && !/Push detail/.test(a.text) && !b.isError && /Push detail/.test(b.text);
    return { calls: [a, b], ok, timed: a.ms };
  },
  // An alert comes up in front: the answer says so and lists only it; answering it closes it.
  alert: async () => {
    await relaunch();
    await act("tap Dialogs");
    const a = await act('tap "Show alert"');
    const b = await act("tap Cancel");
    const ok = !a.isError && /An alert is in front/.test(a.text) && /Delete everything\?/.test(a.text) && !/Show sheet/.test(a.text) && !b.isError && /Result: cancelled/.test(b.text);
    return { calls: [a, b], ok, timed: a.ms };
  },
  // The keyboard comes up for a field: what the tap's answer says about it, a read right after says too.
  keyboard: async () => {
    await relaunch();
    await act("tap Text");
    const a = await act("tap #unicode");
    await sleep(1500);
    const b = await look();
    const shown = (t) => /keyboard: shown|^keyboard/m.test(t);
    // The tap answers before the keyboard has finished coming up; it must not say there is none when one came.
    const ok = !a.isError && !b.isError && (!/keyboard: hidden/.test(a.text) || !shown(b.text));
    return { calls: [a, b], ok, timed: a.ms, note: `answer ${shown(a.text) ? "shows" : "no"} keyboard, read ${shown(b.text) ? "shows" : "no"} keyboard` };
  },
  // A screen that never holds still (a spinner and a ticker): a tap still answers, with its change, and says so.
  ticker: async () => {
    await relaunch();
    await act("tap More", "tap Timing", "tap #ticker");
    const a = await act("tap #count");
    const b = await act("tap #count");
    const ok = !a.isError && /Count: 1/.test(a.text) && !b.isError && /Count: 2/.test(b.text);
    return { calls: [a, b], ok, timed: a.ms };
  },
  // A fill is read back: plain text typed, text in any language pasted.
  fill: async () => {
    await relaunch();
    await act("tap Text");
    const a = await act("fill #unicode hello world");
    const b = await act("fill #unicode Café 日本 🚀");
    const ok = !a.isError && /hello world/.test(a.text) && !b.isError && /Café 日本 🚀/.test(b.text);
    return { calls: [a, b], ok, timed: a.ms };
  },
  // A scroll moves the content, and says where it is.
  scroll: async () => {
    await relaunch();
    await act("tap Lists");
    const a = await act("scroll down");
    const b = await act("scroll up");
    const ok = !a.isError && !/nothing moved/.test(a.text) && /scroll:|moved:|^screen:/m.test(a.text) && !b.isError && !/nothing moved/.test(b.text);
    return { calls: [a, b], ok, timed: a.ms };
  },
  // The screen changes from outside between a read and the next call (a deep link): the call's answer must not
  // count that change as its own, and it must act on the screen as it is.
  outside: async () => {
    await relaunch();
    await act("tap Text");
    await look();
    const n = Math.floor(Math.random() * 1e6);
    simctl("openurl", udid, `edgelab://item/${n}`);
    await sleep(1200);
    const a = await act("tap Apple");
    const b = await look();
    const ok = !a.isError && !/Deep link/.test(a.text) && b.text.includes(`Deep link: edgelab://item/${n}`);
    return { calls: [a, b], ok, timed: a.ms };
  },
};

// iOS asks "Open in EdgeLab?" the first time a link opens it: answer it once, before the runs.
await relaunch();
simctl("openurl", udid, "edgelab://item/0");
await sleep(1500);
{ const r = await look(); if (/Open/.test(r.text) && /system alert|Open in/.test(r.text)) await act("tap Open"); }

const results = { bin, startedAt: new Date().toISOString(), times, cases: {} };
const names = only ? only.split(",") : Object.keys(cases);
for (let round = 0; round < times; round++) {
  for (const name of names) {
    let r;
    try { r = await cases[name](); } catch (e) { r = { ok: false, error: String(e?.stack ?? e), calls: [] }; }
    (results.cases[name] ??= []).push(r);
    console.log(`${name} #${round}: ${r.ok ? "ok" : "FAIL"} ${r.timed ? `${Math.round(r.timed)} ms` : ""}${r.note ? ` (${r.note})` : ""}${r.ok ? "" : `\n  ${r.calls.map((c) => `${c.args?.steps ?? c.name}: ${c.text.replace(/\n/g, " | ").slice(0, 400)}`).join("\n  ")}${r.error ? `\n  ${r.error}` : ""}`}`);
    writeFileSync(out, JSON.stringify(results, null, 1));
  }
}
results.summary = Object.fromEntries(Object.entries(results.cases).map(([name, runs]) => {
  const ms = runs.filter((r) => r.ok && r.timed).map((r) => r.timed);
  return [name, { ok: runs.filter((r) => r.ok).length, n: runs.length, medianMs: median(ms), p90Ms: p90(ms) }];
}));
results.finishedAt = new Date().toISOString();
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary));
await mcp.close();
process.exit(0);
