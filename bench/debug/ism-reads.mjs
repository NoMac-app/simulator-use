// Experiment (not part of the benchmark): what ios-simulator-mcp's ui_describe_all answers right after a boot and right
// after the app is started again, and how long its taps take. Through its MCP server, as the benchmark drives it:
//   source ~/bench-tools/env.sh && node bench/debug/ism-reads.mjs
// For each of 6 fresh app starts (simctl terminate and launch, then the benchmark's 1.5 s), reads every 250 ms for 3 s
// and prints each answer's length, whether it shows the Sign In screen, and the start of any answer that does not;
// then taps Sign In 5 times, each on a fresh app, timing each tap and checking the app's log.
import { join } from "node:path";
import { McpClient } from "../lib/mcp.mjs";
import { AppLog, reboot, resetApp, sleep } from "../lib/sim.mjs";
import adapter from "../tools/ios-simulator-mcp.mjs";

const udid = process.env.UDID, BUNDLE = "dev.simtap.demo";
if (!udid) { console.error("set UDID (source ~/bench-tools/env.sh)"); process.exit(2); }
if (!process.argv.includes("--no-reboot")) await reboot(udid);
await resetApp(udid, BUNDLE, 3000);
const spec = adapter.server({ udid });
const mcp = new McpClient({ ...spec, name: "ios-simulator-mcp" });
await mcp.initialize(120_000); await mcp.listTools(120_000);
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const read = async () => { const r = await mcp.call("ui_describe_all", { udid }, 120_000); const t = text(r); return { ms: Math.round(r.ms), err: r.isError, len: t.length, signIn: /Sign In/.test(t), t }; };

const first = await read();
console.log(`first read after the boot: ${first.ms} ms, error ${first.err}, ${first.len} chars: ${first.t.slice(0, 300)}`);
for (let i = 0; i < 6; i++) {
  await resetApp(udid, BUNDLE);
  const row = [];
  for (let k = 0; k < 12; k++) {
    const r = await read();
    row.push(`${r.ms}ms/${r.len}${r.signIn ? "" : "!"}`);
    if (!r.signIn && k < 3) console.log(`  start ${i} read ${k}: ${r.t.slice(0, 400)}`);
    await sleep(250);
  }
  console.log(`start ${i}: ${row.join(" ")}`);
}
const log = new AppLog(udid, BUNDLE); await sleep(1500);
for (let i = 0; i < 5; i++) {
  await resetApp(udid, BUNDLE);
  const pre = await read();
  const f = JSON.stringify(pre.t).match(/signIn/) ? JSON.parse(pre.t) : null;
  const all = []; const walk = (xs) => { for (const e of xs ?? []) { all.push(e); walk(e.children); } }; walk(f);
  const el = all.find((e) => e.AXUniqueId === "signIn");
  if (!el) { console.log(`tap ${i}: no signIn in the read (${pre.len} chars)`); continue; }
  const mark = log.mark();
  const r = await mcp.call("ui_tap", { udid, x: Math.round(el.frame.x + el.frame.width / 2), y: Math.round(el.frame.y + el.frame.height / 2) }, 120_000);
  console.log(`tap ${i}: ${Math.round(r.ms)} ms, ${text(r)}, landed ${Boolean(await log.waitFor(/sign-in rejected/, mark, 5000))}`);
}
log.stop();
await mcp.close();
adapter.teardown();
process.exit(0);
