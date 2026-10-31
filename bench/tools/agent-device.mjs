// agent-device (Callstack): its stdio MCP server (`agent-device mcp`). Its instructions: open {app, foreground: true}
// first; press/fill with settle: true (the answer is the settled diff); prefer refs, then id selectors.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const bin = () => join(process.env.BENCH_TOOLS ?? "", "bin", "agent-device");
const sel = (what) => ({ kind: "selector", selector: `id="${what}"` });
export default {
  id: "agent-device", name: "agent-device", kind: "mcp",
  server: () => ({ command: bin(), args: ["mcp"] }),
  version: () => execFileSync(bin(), ["--version"], { encoding: "utf8" }).trim(),
  async setup(ctx) { await ctx.call("open", { app: ctx.bundleId, platform: "ios", udid: ctx.udid, foreground: true }, { timeoutMs: 300_000 }); },
  async read(ctx) { await ctx.call("snapshot", { interactiveOnly: true }); },
  async tap(ctx, what) { await ctx.call("press", { target: sel(what), settle: true }); },
  async type(ctx, field, text) { await ctx.call("fill", { target: sel(field), text, settle: true }); },
  async batch(ctx, list) {
    await ctx.call("batch", { steps: list.map(([what, field, value]) => what === "type"
      ? { command: "fill", input: { target: sel(field), text: value } }
      : { command: "press", input: { target: sel(field), settle: true } }) });
  },
  async teardown(ctx) { await ctx.call("close", {}, { allowError: true }); },
  cleanup: ["AgentDeviceRunner"],
};
