// Experiment (not part of the benchmark): where the time of any sequence of calls goes. Runs a script of calls through
// a simulator-use MCP server with SIMULATOR_USE_DEBUG=on and prints each call's time, the first lines of its answer and
// the engine's own timings from stderr (first read, settle, steps).
//   UDID=... node bench/debug/act-profile.mjs SCRIPT [--server PATH_TO_BIN_OR_CLI_JS] [--lines N] [--repeat N] [--json FILE]
// SCRIPT: one call a line, the tool's name then its arguments as JSON; a line starting with # is a comment, and
// "sleep 500" waits. A ui_act line may give its steps alone, one per tab: ui_act<TAB>tap "Items"<TAB>scroll down
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "../lib/mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const udid = process.env.UDID;
const file = process.argv[2];
if (!udid || !file) { console.error("usage: UDID=... node bench/debug/act-profile.mjs SCRIPT [--server PATH] [--lines N] [--repeat N] [--json FILE]"); process.exit(2); }
const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const server = option("--server", join(here, "..", "..", "bin", "simulator-use.js"));
const lines = Number(option("--lines", 3));
const repeat = Number(option("--repeat", 1));
const log = `/tmp/act-profile-${process.pid}.log`;
const mcp = new McpClient({ command: process.execPath, args: [server, "mcp"], env: { SIMULATOR_USE_DEBUG: process.env.PROFILE_DEBUG ?? "on" }, name: "simulator-use", stderrFile: log });
await mcp.initialize(120_000); await mcp.listTools(120_000);
await mcp.call("device_use", { device: udid }, 180_000);
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
let mark = 0;
const debug = () => { const all = existsSync(log) ? readFileSync(log, "utf8").split("\n") : []; const out = all.slice(mark).filter((l) => l.startsWith("simulator-use:")); mark = all.length; return out; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = readFileSync(file, "utf8").split("\n").map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("#"));
const rows = [];
for (let round = 0; round < repeat; round++) {
  for (const line of calls) {
    if (/^sleep \d+$/.test(line)) { await sleep(Number(line.split(" ")[1])); debug(); continue; }
    let name, args;
    if (line.includes("\t")) { const [tool, ...steps] = line.split("\t"); name = tool; args = { steps }; }
    else { const at = line.indexOf(" "); name = at < 0 ? line : line.slice(0, at); args = at < 0 ? {} : JSON.parse(line.slice(at + 1)); }
    debug();
    const r = await mcp.call(name, args, 180_000);
    const answer = text(r);
    const row = { round, call: line.replace(/\t/g, " | "), ms: Math.round(r.ms), error: Boolean(r.isError), answer, debug: debug().map((d) => d.replace(/^simulator-use: */, "")) };
    rows.push(row);
    console.log(`${String(row.ms).padStart(6)} ms${row.error ? " ERROR" : ""}  ${row.call}`);
    for (const l of answer.split("\n").slice(0, lines)) console.log(`          | ${l.slice(0, 160)}`);
    for (const d of row.debug) console.log(`          . ${d}`);
  }
}
const out = option("--json");
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
if (repeat > 1) {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  console.log("\nmedians over rounds:");
  const byCall = new Map();
  for (const r of rows) byCall.set(r.call, [...(byCall.get(r.call) ?? []), r.ms]);
  for (const [call, ms] of byCall) console.log(`${String(Math.round(med(ms))).padStart(6)} ms  (${Math.min(...ms)} to ${Math.max(...ms)})  ${call}`);
}
await mcp.close?.();
process.exit(0);
