import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("the plugin, the registry entry and the package name one version and one command", () => {
  const pkg = read("package.json");
  assert.equal(read(".claude-plugin/plugin.json").version, pkg.version, "bump .claude-plugin/plugin.json with the package");
  const server = read("server.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version, "bump server.json (and its package's version) with the package");
  assert.deepEqual(server.packages.map((p: { identifier: string; version: string }) => [p.identifier, p.version]), [[pkg.name, pkg.version]]);
  // Pinned: the Claude directory refuses an npx launcher without an exact version, and plugin users update with the repo.
  assert.deepEqual(read(".mcp.json").mcpServers["simulator-use"], { command: "npx", args: ["-y", `simulator-use@${pkg.version}`, "mcp"] });
  assert.equal(read(".claude-plugin/marketplace.json").plugins[0].name, read(".claude-plugin/plugin.json").name);
  // Cursor's marketplace and Gemini CLI's gallery read these two from the repo.
  assert.equal(read(".cursor-plugin/plugin.json").version, pkg.version, "bump .cursor-plugin/plugin.json with the package");
  assert.equal(read(".cursor-plugin/plugin.json").mcpServers, ".mcp.json");
  const gemini = read("gemini-extension.json");
  assert.equal(gemini.version, pkg.version, "bump gemini-extension.json with the package");
  assert.deepEqual(gemini.mcpServers["simulator-use"], read(".mcp.json").mcpServers["simulator-use"]);
});
