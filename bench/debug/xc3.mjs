// Discovery: does Xcode's MCP server serve its device-interaction skill as a resource or prompt? (not benchmarked)
import { McpClient } from "../lib/mcp.mjs";
const c = new McpClient({ command: "xcrun", args: ["mcpbridge"] });
const init = await c.initialize(180000); console.log("caps", JSON.stringify(init.result?.capabilities));
for (const m of ["resources/list", "prompts/list", "resources/templates/list"]) { const r = await c.request(m, {}, 60000); console.log(m, JSON.stringify(r.result ?? r.error).slice(0, 1500)); }
await c.close(); process.exit(0);
