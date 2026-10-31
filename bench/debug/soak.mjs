#!/usr/bin/env node
// Does simulator-use slow down over a long session? One MCP server on one phone for --minutes, repeating the sign-in
// an agent does (read, fill email, fill password, tap Sign In, read) after a fresh app start, and a few plain reads.
// Every call's time goes to the output file as it happens, so a run cut short still has its data.
//   node bench/debug/soak.mjs --bin ~/bench-tools/bin/simulator-use --udid $UDID --minutes 40 --out soak.jsonl
// Nothing is retried; a failed call or a missing "Welcome" is counted.
import { appendFileSync, writeFileSync } from "node:fs";
import { McpClient } from "../lib/mcp.mjs";
import { AppLog, resetApp, sleep } from "../lib/sim.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const bin = arg("bin"), udid = arg("udid"), out = arg("out"), minutes = Number(arg("minutes", 40)), relaunchEvery = Number(arg("relaunch-every", 1));
if (!bin || !udid || !out) { console.error("usage: soak.mjs --bin PATH --udid UDID --minutes N --out FILE [--relaunch-every K]"); process.exit(2); }
writeFileSync(out, "");
const write = (row) => appendFileSync(out, `${JSON.stringify(row)}\n`);
const mcp = new McpClient({ command: bin, args: ["mcp"], name: "simulator-use", stderrFile: `${out}.stderr.log` });
await mcp.initialize(180_000);
await mcp.listTools(60_000);
const started = Date.now();
const call = async (round, step, name, args) => {
  const r = await mcp.call(name, args, 120_000);
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  const row = { t: (Date.now() - started) / 1000, round, step, ms: r.ms, error: r.isError, text: text.slice(0, 300) };
  write(row);
  return row;
};
await call(-1, "device_use", "device_use", { device: udid });
await resetApp(udid, "dev.simtap.demo", 3000);
await call(-1, "warmup", "ui_look", {});
const log = new AppLog(udid, "dev.simtap.demo");
let round = 0, failures = 0;
while (Date.now() - started < minutes * 60_000) {
  if (round % relaunchEvery === 0) await resetApp(udid, "dev.simtap.demo", 1500);
  const mark = log.mark();
  const steps = [
    ["read", "ui_look", {}],
    ["fill-email", "ui_act", { steps: ["fill #email gary@example.com"] }],
    ["fill-password", "ui_act", { steps: ["fill #password secret1"] }],
    ["tap", "ui_act", { steps: ["tap #signIn"] }],
    ["final-read", "ui_look", {}],
  ];
  let ok = true;
  for (const [step, name, args] of steps) {
    const row = await call(round, step, name, args);
    if (row.error) ok = false;
    if (step === "final-read" && !/Welcome, gary@example\.com/.test(row.text)) ok = false;
  }
  const line = await log.waitFor(/signed in/, mark, 5000);
  if (!ok || !line) failures++;
  write({ t: (Date.now() - started) / 1000, round, step: "check", ok: ok && Boolean(line) });
  // A few plain reads of the signed-in screen, unchanged.
  for (let i = 0; i < 3; i++) await call(round, "still-read", "ui_look", {});
  round++;
}
write({ done: true, rounds: round, failures });
console.log(`rounds ${round}, failures ${failures}`);
log.stop();
await mcp.close();
process.exit(0);
