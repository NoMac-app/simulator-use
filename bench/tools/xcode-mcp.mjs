// Apple's Xcode MCP server (`xcrun mcpbridge`, Xcode 27), headless (`sudo xcrun mcp-server enable`). Its
// device-interaction skill (Xcode's own, exported with `xcrun agent plugin path`): DeviceInteractionStartSession, then
// DeviceInteractionSynthesize, which runs a command (`t x y` taps at a hitPoint, `sender keyboard kbd <text>` types,
// last in a chain) and answers with paths to a screenshot and a UI hierarchy file. The skill says to read the
// hierarchy before and after every interaction, so each answer's hierarchy file counts toward that step's tokens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { need } from "./lib.mjs";

// The answer is JSON text with escaped slashes; read the fields from it even when other text comes with it.
const field = (rec, name) => { const m = rec.text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? JSON.parse(`"${m[1]}"`) : null; };
const answer = (rec) => ({ hierarchyPath: field(rec, "hierarchyPath"), interactionSessionKey: field(rec, "interactionSessionKey") });
function openHierarchy(ctx, rec) {
  const p = answer(rec).hierarchyPath;
  if (!p) throw Object.assign(new Error(`DeviceInteractionSynthesize answered no hierarchy: ${rec.text.slice(0, 400)}`), { name: "TargetError" });
  ctx.attachFile(rec, readFileSync(p, "utf8"));
}
// A hierarchy line: `TextField, {{32.0, 183.0}, {338.0, 22.0}}, identifier: 'email', ..., hitPoint: {201.0, 194.0}`.
function point(ctx, what) {
  const line = String(ctx.lastRead).split("\n").find((l) => l.includes(`identifier: '${what}'`));
  const m = line?.match(/hitPoint: \{([\d.]+), ([\d.]+)\}/);
  return need(m ? { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) } : null, what, "Xcode MCP");
}
async function synth(ctx, command) {
  const rec = await ctx.call("DeviceInteractionSynthesize", { interactSessionKey: ctx.state.key, ...(command ? { interactionCommand: command } : {}) }, { timeoutMs: 180_000 });
  if (rec.text.includes('"type":"error"')) throw Object.assign(new Error(`DeviceInteractionSynthesize failed: ${rec.text.slice(0, 400)}`), { name: "TargetError" });
  openHierarchy(ctx, rec);
  return rec;
}
export default {
  id: "xcode-mcp", name: "Xcode MCP", kind: "mcp",
  notes: [
    "Xcode's DeviceInteractionSynthesize answers with file paths; each step counts the UI hierarchy file the agent opens (as Xcode's device-interaction skill says to), not the screenshot.",
    "Its session start tells the agent to hand interactions to a subagent with Xcode's device-interaction skill; the harness makes the same calls itself.",
  ],
  server: () => ({ command: "xcrun", args: ["mcpbridge"] }),
  version: () => execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).trim().replace(/\n/g, ", "),
  // A fresh Xcode service, so no earlier session holds the Simulator.
  prepare() { try { execFileSync("xcrun", ["mcp-server", "stop"], { stdio: "ignore" }); } catch {} },
  async setup(ctx) {
    const r = await ctx.call("DeviceInteractionStartSession", { deviceIdentifier: ctx.udid, sessionIdentifier: `Benchmark Sign In ${Date.now()}` }, { timeoutMs: 300_000 });
    ctx.state.key = need(answer(r).interactionSessionKey, "the session key", "Xcode MCP");
  },
  async read(ctx) { await synth(ctx, null); },
  async tap(ctx, what) { const p = point(ctx, what); await synth(ctx, `t ${p.x} ${p.y}`); },
  // One chained command: tap the field, then type (typing must come last in a chain).
  async type(ctx, field, text) { const p = point(ctx, field); await synth(ctx, `t ${p.x} ${p.y} sender keyboard kbd ${text}`); },
  async teardown(ctx) { if (ctx.state.key) await ctx.call("DeviceInteractionEndSession", { interactionSessionKey: ctx.state.key }, { allowError: true }); },
  cleanup: ["mcpbridge"],
};
