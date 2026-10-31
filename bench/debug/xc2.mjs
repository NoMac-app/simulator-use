// Discovery: which DeviceInteractionSynthesize command types text (not part of the benchmark).
import { readFileSync } from "node:fs";
import { McpClient } from "../lib/mcp.mjs";
const udid = process.env.UDID;
const c = new McpClient({ command: "xcrun", args: ["mcpbridge"] });
await c.initialize(180000); await c.listTools(180000);
const s = await c.call("DeviceInteractionStartSession", { deviceIdentifier: udid, sessionIdentifier: `Benchmark Discovery ${Date.now()}` }, 300000);
console.log("start", s.content[0]?.text?.slice(0, 200)); const key = JSON.parse(s.content[0].text).interactionSessionKey;
await c.call("DeviceInteractionSynthesize", { interactSessionKey: key, interactionCommand: "t 201 194" }, 180000);
for (const w of ["x", "s", "kb", "ty", "tt", "text", "txt", "input", "i", "e", "key", "keys", "type:", "write", "sender", "kbd:", "str", "string", "enter", "p", "w 0.1 x"]) {
  const r = await c.call("DeviceInteractionSynthesize", { interactSessionKey: key, interactionCommand: `${w} ab` }, 60000);
  const txt = r.content.map((x) => x.text).join(" ");
  console.log(w, "->", txt.slice(0, 120));
  if (!/Invalid command/.test(txt)) { console.log("CANDIDATE", JSON.stringify(w), r.isError, txt.slice(0, 300)); try { const h = readFileSync(JSON.parse(txt).hierarchyPath, "utf8"); console.log(h.split("\n").filter((l) => /TextField/.test(l)).join(" | ").slice(0, 400)); } catch {} }
}
await c.call("DeviceInteractionEndSession", { interactionSessionKey: key });
await c.close(); process.exit(0);
