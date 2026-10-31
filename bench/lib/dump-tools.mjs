// Prints a server's initialize answer and tools/list as JSON: node dump-tools.mjs out.json -- command args...
import { writeFileSync } from "node:fs";
import { McpClient } from "./mcp.mjs";

const [out, sep, command, ...args] = process.argv.slice(2);
if (!out || sep !== "--" || !command) { console.error("usage: dump-tools.mjs out.json -- command args..."); process.exit(2); }
const c = new McpClient({ command, args, name: command });
const init = await c.initialize(180_000);
const list = init.error ? { error: "initialize failed" } : await c.listTools(180_000);
writeFileSync(out, JSON.stringify({ initialize: init.result ?? init.error, initMs: init.ms, listMs: list.ms, tools: list.tools ?? [], error: list.error, stray: c.strayStdout }, null, 1));
console.log(`${command}: ${list.tools?.length ?? 0} tools, init ${init.ms?.toFixed(0)} ms${init.error ? " ERROR " + JSON.stringify(init.error) : ""}`);
await c.close();
process.exit(0);
