// ios-simulator-mcp (Joshua Yoes): its MCP server as its README configures it (npx -y ios-simulator-mcp; here the
// same pinned package, installed). It drives the Simulator through Facebook's IDB, the idb_companion binary and the
// fb-idb client, installed as its TROUBLESHOOTING.md says (Homebrew and uv), with IOS_SIMULATOR_MCP_IDB_PATH naming
// the client as its README's configuration does. ui_describe_all reads the accessibility tree as JSON; ui_tap taps at
// x,y in points, taken from the centre of the element's frame in the latest read (its README's way: "Tap on
// coordinates x=250, y=400"); ui_type types into the focused field, so typing is a tap on the field and a ui_type.
// No setup: its docs ask for none (a booted Simulator), and every call names the Simulator by udid. No batch tool.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IDS, LABELS, need } from "./lib.mjs";

const root = () => join(process.env.BENCH_TOOLS ?? "", "lib", "node_modules", "ios-simulator-mcp");
const idb = () => process.env.IDB_BIN ?? join(homedir(), ".local", "bin", "idb");
const out = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };

/** The element with the id (else the label) in a ui_describe_all answer: idb's nested JSON, an array of elements. */
function find(text, what) {
  let tree;
  try { tree = JSON.parse(String(text)); } catch { return null; }
  const all = [];
  const walk = (xs) => { for (const e of Array.isArray(xs) ? xs : [xs]) { if (!e || typeof e !== "object") continue; all.push(e); walk(e.children ?? []); } };
  walk(tree);
  return all.find((e) => e.AXUniqueId === IDS[what]) ?? all.find((e) => e.AXLabel === LABELS[what]) ?? null;
}
function point(ctx, what) {
  const f = find(ctx.lastRead, what)?.frame;
  return need(f ? { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) } : null, what, "ios-simulator-mcp");
}

export default {
  id: "ios-simulator-mcp", name: "ios-simulator-mcp", kind: "mcp",
  // The IDB it ran on, for the results file.
  get notes() {
    const companion = out("brew", ["list", "--versions", "idb-companion"]);
    const client = out("uv", ["tool", "list"])?.split("\n").find((l) => l.startsWith("fb-idb"));
    return [`ios-simulator-mcp drives the Simulator through Facebook's IDB: ${companion ?? "idb-companion (version unknown)"} (Homebrew), ${client ?? "fb-idb (version unknown)"} (uv).`];
  },
  server: () => ({ command: process.execPath, args: [join(root(), "build", "index.js")], env: { IOS_SIMULATOR_MCP_IDB_PATH: idb() } }),
  version: () => JSON.parse(readFileSync(join(root(), "package.json"), "utf8")).version,
  async read(ctx) { await ctx.call("ui_describe_all", { udid: ctx.udid }); },
  async tap(ctx, what) { const p = point(ctx, what); await ctx.call("ui_tap", { udid: ctx.udid, x: p.x, y: p.y }); },
  async type(ctx, field, text) {
    const p = point(ctx, field);
    await ctx.call("ui_tap", { udid: ctx.udid, x: p.x, y: p.y });
    await ctx.call("ui_type", { udid: ctx.udid, text });
  },
  // idb's companion outlives the server: stop it the way idb does, before the leftovers are killed.
  teardown() { out(idb(), ["kill"]); },
  cleanup: ["idb_companion", "uv/tools/fb-idb"],
};
