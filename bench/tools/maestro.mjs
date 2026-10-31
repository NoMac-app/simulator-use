// Maestro's MCP server (`maestro mcp`, inside the Maestro CLI; needs Java 17+). inspect_screen reads the screen;
// run executes inline Maestro YAML (tapOn by id, inputText), the way its docs prefer for exploration.
import { execFileSync } from "node:child_process";
const MAESTRO = process.env.MAESTRO_BIN ?? "maestro";
// Inline flows need the config section (appId), or run answers "Config Section Required".
const y = (cmds) => ["appId: dev.simtap.demo", "---", ...cmds].join("\n");
const stepsFor = (list) => list.flatMap(([what, field, value]) => what === "type" ? [`- tapOn:\n    id: "${field}"`, `- inputText: "${value}"`] : [`- tapOn:\n    id: "${field}"`]);
export default {
  id: "maestro", name: "Maestro MCP", kind: "mcp",
  server: () => ({ command: MAESTRO, args: ["mcp"] }),
  version: () => execFileSync(MAESTRO, ["--version"], { encoding: "utf8" }).trim().split("\n").pop(),
  async setup(ctx) { await ctx.call("list_devices", {}, { timeoutMs: 300_000 }); },
  async read(ctx) { await ctx.call("inspect_screen", { device_id: ctx.udid }, { timeoutMs: 300_000 }); },
  async tap(ctx, what) { await ctx.call("run", { device_id: ctx.udid, yaml: y(stepsFor([["tap", what]])) }, { timeoutMs: 300_000 }); },
  async type(ctx, field, text) { await ctx.call("run", { device_id: ctx.udid, yaml: y(stepsFor([["type", field, text]])) }, { timeoutMs: 300_000 }); },
  async batch(ctx, list) { await ctx.call("run", { device_id: ctx.udid, yaml: y(stepsFor(list)) }, { timeoutMs: 300_000 }); },
  cleanup: ["maestro.cli", "maestro-driver"],
};
