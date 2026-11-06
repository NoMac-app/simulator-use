// mobile-mcp (Mobile Next): its MCP server as its README configures it (npx @mobilenext/mobile-mcp; here the same
// pinned package, installed). Reads with mobile_list_elements_on_screen, taps by @ref, types into the focused field.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineFor, need } from "./lib.mjs";
const root = () => join(process.env.BENCH_TOOLS ?? "", "lib", "node_modules", "@mobilenext", "mobile-mcp");
const ref = (ctx, what) => need(lineFor(ctx.lastRead, what)?.match(/@e\d+/)?.[0], what, "mobile-mcp");
const steps = (ctx, list) => list.flatMap(([what, field, value]) => what === "type"
  ? [{ name: "mobile_click_on_screen_at_coordinates", arguments: { ref: ref(ctx, field) } }, { name: "mobile_type_keys", arguments: { text: value, submit: false } }]
  : [{ name: "mobile_click_on_screen_at_coordinates", arguments: { ref: ref(ctx, field) } }]);
export default {
  id: "mobile-mcp", name: "mobile-mcp", kind: "mcp",
  server: () => ({ command: process.execPath, args: [join(root(), "lib", "index.js")] }),
  version: () => JSON.parse(readFileSync(join(root(), "package.json"), "utf8")).version,
  // Its first screen read starts its on-device agent, which leaves the Home Screen in front (seen in every probe);
  // its instructions say to open apps with mobile_launch_app, so the setup does that after the agent is up.
  // On the November 6, 2026 Mac that first read failed twice ("failed to start agent ... timed out waiting for
  // WebDriverAgent to be ready", after 37 s and 23 s) and the next read worked, with the Home Screen in front, so the
  // setup reads once more when the first read fails, as an agent would after that error, then opens the app. Setup
  // only: no measured step is ever tried again.
  async setup(ctx) {
    await ctx.call("mobile_list_available_devices", {});
    const first = await ctx.call("mobile_list_elements_on_screen", { device: ctx.udid }, { timeoutMs: 300_000, allowError: true });
    if (first.isError) await ctx.call("mobile_list_elements_on_screen", { device: ctx.udid }, { timeoutMs: 300_000 });
    await ctx.call("mobile_launch_app", { device: ctx.udid, packageName: ctx.bundleId });
  },
  async read(ctx) { await ctx.call("mobile_list_elements_on_screen", { device: ctx.udid }); },
  async tap(ctx, what) { await ctx.call("mobile_click_on_screen_at_coordinates", { device: ctx.udid, ref: ref(ctx, what) }); },
  async type(ctx, field, text) {
    await ctx.call("mobile_click_on_screen_at_coordinates", { device: ctx.udid, ref: ref(ctx, field) });
    await ctx.call("mobile_type_keys", { device: ctx.udid, text, submit: false });
  },
  async batch(ctx, list) { await ctx.call("mobile_batch_commands", { device: ctx.udid, steps: steps(ctx, list), stopOnError: true }); },
  cleanup: ["mobilecli", "devicekit"],
};
