// AXe: a command-line tool (no MCP server); one process per call, as its README uses it.
import { execFileSync } from "node:child_process";
const AXE = process.env.AXE_BIN ?? "axe";
export default {
  id: "axe", name: "AXe", kind: "cli",
  notes: ["AXe has no MCP server: each step is one `axe` process, timed from spawn to exit, and its output is what the agent reads."],
  version: () => execFileSync(AXE, ["--version"], { encoding: "utf8" }).trim(),
  async read(ctx) { await ctx.cli(AXE, ["describe-ui", "--udid", ctx.udid]); },
  async tap(ctx, what) { await ctx.cli(AXE, ["tap", "--id", what, "--udid", ctx.udid]); },
  async type(ctx, field, text) {
    await ctx.cli(AXE, ["tap", "--id", field, "--udid", ctx.udid]);
    await ctx.cli(AXE, ["type", text, "--udid", ctx.udid]);
  },
  // AXe's batch: several steps in one process and one HID session (`axe batch --step ...`).
  async batch(ctx, list) {
    const steps = list.flatMap(([what, field, value]) => what === "type" ? [`tap --id ${field}`, `type '${value}'`] : [`tap --id ${field}`]);
    await ctx.cli(AXE, ["batch", "--udid", ctx.udid, ...steps.flatMap((s) => ["--step", s])]);
  },
};
