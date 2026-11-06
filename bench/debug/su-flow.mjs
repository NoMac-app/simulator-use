// Experiment (not part of the benchmark): where simulator-use's time goes in the benchmark's sign-in. Runs the sign-in
// N times through its MCP server, as bench/tools/simulator-use.mjs does, with SIMULATOR_USE_DEBUG=on, and prints each
// call's time and the engine's own timings from stderr (first read, settle, steps).
//   source ~/bench-tools/env.sh && node bench/debug/su-flow.mjs [N] [--server PATH_TO_BIN_OR_CLI_JS]
// --server runs another build (a checkout's dist/cli.js or bin/simulator-use.js) instead of the pinned package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "../lib/mcp.mjs";
import { resetApp, sleep } from "../lib/sim.mjs";

const udid = process.env.UDID, BUNDLE = "dev.simtap.demo";
if (!udid) { console.error("set UDID (source ~/bench-tools/env.sh)"); process.exit(2); }
const n = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5);
const at = process.argv.indexOf("--server");
const server = at > 0 ? process.argv[at + 1] : join(process.env.BENCH_TOOLS ?? "", "bin", "simulator-use");
const log = `/tmp/su-flow-${process.pid}.log`;
const spec = server.endsWith(".js") ? { command: process.execPath, args: [server, "mcp"] } : { command: server, args: ["mcp"] };
const mcp = new McpClient({ ...spec, env: { SIMULATOR_USE_DEBUG: "on" }, name: "simulator-use", stderrFile: log });
await mcp.initialize(120_000); await mcp.listTools(120_000);
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
await mcp.call("device_use", { device: udid }, 120_000);
let mark = 0;
const debug = () => { const all = existsSync(log) ? readFileSync(log, "utf8").split("\n") : []; const out = all.slice(mark).filter((l) => l.startsWith("simulator-use:")); mark = all.length; return out; };
const rows = [];
for (let i = 0; i < n; i++) {
  await resetApp(udid, BUNDLE);
  await sleep(200); debug();
  const calls = [["ui_look", {}], ["ui_act", { steps: ["fill #email gary@example.com"] }], ["ui_act", { steps: ["fill #password secret1"] }], ["ui_act", { steps: ["tap #signIn"] }], ["ui_look", {}]];
  const row = [];
  for (const [name, args] of calls) {
    const r = await mcp.call(name, args, 120_000);
    await sleep(50);
    row.push({ call: `${name} ${args.steps?.[0]?.split(" ").slice(0, 2).join(" ") ?? ""}`.trim(), ms: Math.round(r.ms), err: r.isError, answer: text(r).split("\n").slice(0, 2).join(" / ").slice(0, 120), debug: debug() });
  }
  const ok = /Welcome, gary@example\.com/.test(text(await mcp.call("ui_look", {}, 60_000)));
  rows.push(row);
  console.log(`sign-in ${i}: ${row.reduce((s, c) => s + c.ms, 0)} ms, ${ok ? "signed in" : "NOT signed in"}`);
  for (const c of row) console.log(`  ${c.call}: ${c.ms} ms${c.err ? " ERROR" : ""} | ${c.answer}\n${c.debug.map((d) => `      ${d.replace(/^simulator-use: */, "")}`).join("\n")}`);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
console.log("medians:", rows[0].map((c, k) => `${c.call} ${med(rows.map((r) => r[k].ms))} ms`).join(" | "), `| total ${med(rows.map((r) => r.reduce((s, c) => s + c.ms, 0)))} ms`);
await mcp.close();
process.exit(0);
