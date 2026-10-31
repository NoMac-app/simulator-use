// Argent (Software Mansion): its MCP server (`argent mcp`, after `npm i -g @swmansion/argent` as its docs add it by
// hand). describe gives elements; gesture-tap takes coordinates from 0 to 1; keyboard types into the focused field.
// Every interaction answers with a screenshot and the element tree of the settled screen.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineFor, need } from "./lib.mjs";
const bin = () => join(process.env.BENCH_TOOLS ?? "", "bin", "argent");
// A line such as `AXButton "Sign In" id="signIn"  (0.040, 0.371, 0.920, 0.059)`: a normalized frame; its docs say to
// tap the centre, x + width / 2 and y + height / 2.
// describe answers JSON whose "description" holds the element list in one escaped string; the answers of actions
// print it as plain lines. Both become plain lines here.
function screenText(text) {
  const s = String(text);
  try { const j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); if (typeof j.description === "string") return j.description; } catch {}
  return s;
}
function point(ctx, what) {
  const line = lineFor(screenText(ctx.lastRead), what);
  const m = line?.match(/\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/);
  const [x, y, w, h] = m ? m.slice(1).map(Number) : [];
  return need(m ? { x: +(x + w / 2).toFixed(4), y: +(y + h / 2).toFixed(4) } : null, what, "Argent");
}
export default {
  id: "argent", name: "Argent", kind: "mcp", actionsReturnScreen: true,
  server: () => ({ command: bin(), args: ["mcp"] }),
  version: () => JSON.parse(readFileSync(join(process.env.BENCH_TOOLS ?? "", "lib", "node_modules", "@swmansion", "argent", "package.json"), "utf8")).version,
  // Its first describe answers an empty tree with the hint "this simulator was not booted through argent, so the
  // pre-boot accessibility settings were never applied"; boot-device with force=true aborted after 157 s in a probe.
  // So the setup lets Argent boot the Simulator itself (shut down first), then opens the app with launch-app.
  async setup(ctx) {
    execFileSync("xcrun", ["simctl", "shutdown", ctx.udid], { stdio: "ignore" });
    await ctx.call("boot-device", { udid: ctx.udid }, { timeoutMs: 300_000 });
    await ctx.call("launch-app", { udid: ctx.udid, bundleId: ctx.bundleId }, { timeoutMs: 120_000 });
  },
  async read(ctx) { await ctx.call("describe", { udid: ctx.udid }); },
  // run-sequence: "If the agent knows several actions before the start ... runs them as one sequence."
  async batch(ctx, list) {
    const steps = list.flatMap(([what, field, value]) => {
      const p = point(ctx, field);
      const tap = { tool: "gesture-tap", args: { x: p.x, y: p.y } };
      return what === "type" ? [tap, { tool: "keyboard", args: { text: value } }] : [tap];
    });
    await ctx.call("run-sequence", { udid: ctx.udid, steps }, { timeoutMs: 120_000 });
  },
  async tap(ctx, what) { const p = point(ctx, what); await ctx.call("gesture-tap", { udid: ctx.udid, x: p.x, y: p.y }); },
  async type(ctx, field, text) {
    const p = point(ctx, field);
    await ctx.call("gesture-tap", { udid: ctx.udid, x: p.x, y: p.y });
    await ctx.call("keyboard", { udid: ctx.udid, text });
  },
  cleanup: ["simulator-server", "ax-service"],
};
