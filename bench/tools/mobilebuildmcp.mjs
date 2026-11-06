// MobileBuildMCP (Sentry; formerly XcodeBuildMCP): its MCP server (`mobilebuildmcp mcp`). Tapping and typing are in
// its ui-automation workflow, which is off by default; its docs enable it with MOBILEBUILDMCP_ENABLED_WORKFLOWS.
// snapshot_ui gives elementRefs; tap and type_text take one; refresh with snapshot_ui when the answer says to.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineFor, need } from "./lib.mjs";
const bin = () => join(process.env.BENCH_TOOLS ?? "", "bin", "mobilebuildmcp");
const ref = (ctx, what) => need(lineFor(ctx.lastRead, what)?.match(/\b(e\d+)\b/)?.[1], what, "MobileBuildMCP");
export default {
  id: "mobilebuildmcp", name: "MobileBuildMCP (formerly XcodeBuildMCP)", kind: "mcp",
  server: (ctx) => ({ command: bin(), args: ["mcp"], env: { MOBILEBUILDMCP_ENABLED_WORKFLOWS: "simulator,ui-automation", MOBILEBUILDMCP_SIMULATOR_ID: ctx.udid } }),
  version: () => JSON.parse(readFileSync(join(process.env.BENCH_TOOLS ?? "", "lib", "node_modules", "mobilebuildmcp", "package.json"), "utf8")).version,
  async read(ctx) { await ctx.call("snapshot_ui", {}); },
  async tap(ctx, what) { await ctx.call("tap", { elementRef: ref(ctx, what) }); },
  async type(ctx, field, text) { await ctx.call("type_text", { elementRef: ref(ctx, field), text, replaceExisting: true }); },
  // snapshot_ui lists only targets, not the status text; its own tip: "Use wait_for_ui for text/assertions".
  async finalRead(ctx) { await ctx.call("wait_for_ui", { predicate: "textContains", text: "Welcome, gary@example.com", timeoutMs: 5000 }); },
  welcomeSeen: (calls) => calls.length > 0 && !calls.at(-1).isError,
  // Its tool descriptions: refs stay usable on the same screen, but "refresh after ... obvious layout changes".
  // Typing brings up the keyboard, and the first pass showed the next ref refused ("does not support typeText"),
  // so the agent refreshes with snapshot_ui after each type_text (that call counts in the flow).
  refreshAfter: (calls) => calls.some((c) => c.tool === "type_text" || /Refresh after UI action|refresh with snapshot_ui/i.test(c.text)),
  cleanup: [],
};
