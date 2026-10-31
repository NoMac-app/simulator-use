// Discovery for Xcode's DeviceInteractionSynthesize command grammar (not part of the benchmark).
import { readFileSync } from "node:fs";
import { McpClient } from "../lib/mcp.mjs";
import { resetApp } from "../lib/sim.mjs";
const udid = process.env.UDID;
const c = new McpClient({ command: "xcrun", args: ["mcpbridge"], stderrFile: process.env.HOME + "/xc.stderr" });
console.log("init", JSON.stringify((await c.initialize(180000)).result?.serverInfo));
const l = await c.listTools(180000); console.log("tools", l.tools.length, l.error ?? "");
const t = (r) => (r.error ? "ERR " + JSON.stringify(r.error) : "") + r.content.map((x) => x.type === "text" ? x.text : `[${x.type}]`).join("\n") + (r.structured ? "\nSTRUCT " + JSON.stringify(r.structured).slice(0, 800) : "");
const s = await c.call("DeviceInteractionStartSession", { deviceIdentifier: udid, sessionIdentifier: `Benchmark Discovery ${Date.now()}` }, 300000);
console.log("START", s.ms.toFixed(0), t(s).slice(0, 1500));
const key = (t(s).match(/"interactionSessionKey"\s*:\s*"([^"]+)"/) ?? [])[1];
console.log("KEY", key);
await resetApp(udid, "dev.simtap.demo");
const r = await c.call("DeviceInteractionSynthesize", { interactSessionKey: key }, 180000);
console.log("SYNTH", r.ms.toFixed(0), t(r).slice(0, 1500));
const hp = JSON.parse(r.content[0].text).hierarchyPath;
if (hp) { const h = readFileSync(hp, "utf8"); console.log("HIER chars", h.length, h.slice(0, 2500)); }
console.log("TAPEMAIL", t(await c.call("DeviceInteractionSynthesize", { interactSessionKey: key, interactionCommand: "t 201 194" }, 180000)).slice(0, 200));
for (const cmd of ["kbd gary@example.com", "k gary@example.com", "type gary@example.com"]) {
  const r2 = await c.call("DeviceInteractionSynthesize", { interactSessionKey: key, interactionCommand: cmd }, 180000);
  console.log("CMD", cmd, r2.ms.toFixed(0), r2.isError, t(r2).slice(0, 300));
  try { const h2 = readFileSync(JSON.parse(r2.content[0].text).hierarchyPath, "utf8"); console.log("  email line:", h2.split("\n").filter((x) => /email|gary/i.test(x)).join(" | ").slice(0, 400)); } catch (e) { console.log("  no hierarchy", e.message); }
}
await c.call("DeviceInteractionEndSession", { interactionSessionKey: key });
await c.close(); process.exit(0);
