// simulator-use: its MCP server (`simulator-use mcp`), as its README installs it. Targets by #id; ui_act answers with what changed.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const bin = (name) => join(process.env.BENCH_TOOLS ?? "", "bin", name);
export default {
  id: "simulator-use", name: "simulator-use", kind: "mcp",
  server: () => ({ command: bin("simulator-use"), args: ["mcp"] }),
  version: () => execFileSync(bin("simulator-use"), ["--version"], { encoding: "utf8" }).trim(),
  async setup(ctx) { await ctx.call("device_use", { device: ctx.udid }); },
  async read(ctx) { await ctx.call("ui_look", {}); },
  async tap(ctx, what) { await ctx.call("ui_act", { steps: [`tap #${what}`] }); },
  async type(ctx, field, text) { await ctx.call("ui_act", { steps: [`fill #${field} ${text}`] }); },
  async batch(ctx, steps) {
    await ctx.call("ui_act", { steps: steps.map(([what, field, value]) => (what === "type" ? `fill #${field} ${value}` : `tap #${field}`)) });
  },
  cleanup: ["simulator-use-engine"],
};
