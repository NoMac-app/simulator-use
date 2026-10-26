import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { help, parseArgs, usage } from "../src/cli.ts";
import { handle, serve, SUPPORTED_VERSIONS } from "../src/mcp.ts";
import { callTool, INSTRUCTIONS, TOOLS } from "../src/registry.ts";

const tokens = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
const request = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => handle({ jsonrpc: "2.0", id, method, params });
const v2026 = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };

test("the tool list plus instructions stays within 4,000 tokens, at most 13 tools, each 300 or fewer", async () => {
  const listed = ((await request("tools/list"))?.result as { tools: unknown[] }).tools;
  assert.ok(TOOLS.length <= 13);
  assert.ok(tokens(listed) + tokens(INSTRUCTIONS) <= 4000, `${tokens(listed) + tokens(INSTRUCTIONS)} tokens`);
  for (const tool of listed) assert.ok(tokens(tool) <= 300, `${(tool as { name: string }).name}: ${tokens(tool)} tokens`);
});

test("every tool: unique snake_case name and CLI command, the five annotations, read tools marked read-only", () => {
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  assert.equal(new Set(TOOLS.map((t) => t.command)).size, TOOLS.length);
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/);
    assert.ok(tool.title);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) assert.equal(typeof tool.annotations[hint], "boolean");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.ok(TOOLS.find((t) => t.name === "devices")?.annotations.readOnlyHint);
  assert.ok(TOOLS.find((t) => t.name === "ui_look")?.annotations.readOnlyHint);
  assert.equal(TOOLS.find((t) => t.name === "ui_act")?.annotations.readOnlyHint, false);
});

test("the CLI offers every tool and every argument the MCP server does", () => {
  for (const tool of TOOLS) {
    assert.ok(help().includes(`  ${tool.command} `), `help lists ${tool.command}`);
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      if (prop.type === "array") {
        // A list argument takes the command's words: simulator-use act "tap #a" "tap #b".
        assert.ok(usage(tool).includes(`<${key}...>`), `usage of ${tool.command} shows <${key}...>`);
        assert.deepEqual(parseArgs(tool, ["tap #a", "tap #b"]), { [key]: ["tap #a", "tap #b"] });
        continue;
      }
      const flag = `--${key.replace(/_/g, "-")}`;
      // A positional argument shows as [key] and is also taken as a flag.
      assert.ok(usage(tool).includes(tool.positional?.includes(key) ? `[${key}]` : flag), `usage of ${tool.command} lists ${key}`);
      const parsed = parseArgs(tool, prop.type === "boolean" ? [flag] : [flag, prop.type === "number" ? "3" : "x"]);
      assert.deepEqual(parsed, { [key]: prop.type === "boolean" ? true : prop.type === "number" ? 3 : "x" });
    }
    assert.match(String(parseArgs(tool, ["--nope"])), /Unknown option --nope/);
    const takesWords = tool.positional?.length || Object.values(tool.inputSchema.properties).some((p) => p.type === "array");
    if (!takesWords) assert.match(String(parseArgs(tool, ["word"])), /Unexpected "word"/);
  }
});

test("MCP 2024-11-05 to 2025-11-25: initialize answers the client's version, or the newest it knows", async () => {
  const asked = (await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))?.result as Record<string, unknown>;
  assert.equal(asked.protocolVersion, "2025-06-18");
  assert.deepEqual(asked.serverInfo, { name: "simulator-use", version: asked.serverInfo && (asked.serverInfo as { version: string }).version });
  assert.equal(asked.instructions, INSTRUCTIONS);
  const unknown = (await request("initialize", { protocolVersion: "2031-01-01" }))?.result as Record<string, unknown>;
  assert.equal(unknown.protocolVersion, "2025-11-25");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await request("ping"))?.result, {});
});

test("MCP 2026-07-28: server/discover, per-request versions, cacheable lists, resultType", async () => {
  const discover = (await request("server/discover", v2026))?.result as Record<string, unknown>;
  assert.deepEqual(discover.supportedVersions, SUPPORTED_VERSIONS);
  assert.ok(SUPPORTED_VERSIONS.includes("2026-07-28") && SUPPORTED_VERSIONS.includes("2025-06-18"));
  assert.equal(discover.resultType, "complete");
  const list = (await request("tools/list", v2026))?.result as Record<string, unknown>;
  assert.equal(list.resultType, "complete");
  assert.equal(list.cacheScope, "public");
  assert.ok(Number(list.ttlMs) > 0);
  assert.deepEqual(list._meta, { "io.modelcontextprotocol/serverInfo": discover._meta && (discover._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"] });
  const legacy = (await request("tools/list"))?.result as Record<string, unknown>;
  assert.equal(legacy.resultType, undefined);
  const wrong = await request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } });
  assert.equal(wrong?.error?.code, -32022);
  assert.deepEqual(wrong?.error?.data, { supported: SUPPORTED_VERSIONS, requested: "2030-01-01" });
});

test("MCP errors: unknown method, unknown tool, bad arguments", async () => {
  assert.equal((await request("resources/list"))?.error?.code, -32601);
  const unknown = (await request("tools/call", { name: "nope" }))?.result as { isError: boolean; content: { text: string }[] };
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0]!.text, /No tool named "nope"\. Tools: devices, device_use, app_run, ui_look, ui_act, app_control, app_logs, tests_run, job_status, job_cancel, screen_record/);
  const bad = await callTool("ui_look", { screenshot: "yes" });
  assert.deepEqual(bad, { text: "ui_look: screenshot must be a boolean.", isError: true });
  assert.match((await callTool("ui_look", { zoom: 2 })).text, /ui_look has no argument "zoom"\. It takes: device, find, screenshot, screenshot_file, full\./);
  assert.deepEqual(await callTool("ui_act", {}), { text: "ui_act needs steps.", isError: true });
  assert.deepEqual(await callTool("ui_act", { steps: "tap #a" }), { text: "ui_act: steps must be a list of strings.", isError: true });
  assert.deepEqual(await callTool("ui_act", { steps: [] }), { text: "ui_act: steps needs at least 1.", isError: true });
});

test("the stdio server answers each line with its id and ignores notifications", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve(input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n");
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: "b", method: "tools/list" })}\n`);
  await done;
  const replies = String(output.read()).trim().split("\n").map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
  assert.deepEqual(replies.map((r) => r.id).sort(), [1, "b", null].sort());
  assert.equal(replies.find((r) => r.id === null)?.error?.code, -32700);
});

test("the skill stays within 2 KB and names the main commands", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  assert.ok(Buffer.byteLength(skill) <= 2048, `${Buffer.byteLength(skill)} bytes`);
  for (const command of ["run", "look", "act", "logs", "test", "use", "app", "record"]) assert.match(skill, new RegExp(`simulator-use ${command}\\b`));
  assert.doesNotMatch(skill, /—/, "no em dashes");
});

test("a hosted server takes the account's build cache at hand-over; a local one has no such method", async () => {
  const saved = { hosted: process.env.SIMULATOR_USE_HOSTED, cache: process.env.SIMULATOR_USE_CACHE_DIR };
  try {
    delete process.env.SIMULATOR_USE_HOSTED;
    assert.equal((await request("simulator-use/configure", { cache_dir: "/Volumes/nmw-x/cache" }))?.error?.code, -32601);
    process.env.SIMULATOR_USE_HOSTED = "1";
    assert.deepEqual((await request("simulator-use/configure", { cache_dir: "/Volumes/nmw-x/cache" }))?.result, {});
    assert.equal(process.env.SIMULATOR_USE_CACHE_DIR, "/Volumes/nmw-x/cache");
    for (const bad of ["relative/cache", "/Volumes/../etc", 5]) {
      assert.equal((await request("simulator-use/configure", { cache_dir: bad }))?.error?.code, -32602, String(bad));
    }
    assert.equal(process.env.SIMULATOR_USE_CACHE_DIR, "/Volumes/nmw-x/cache");
  } finally {
    for (const [key, value] of [["SIMULATOR_USE_HOSTED", saved.hosted], ["SIMULATOR_USE_CACHE_DIR", saved.cache]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the built tools.json lists the tools exactly as the MCP server does", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const file = new URL("../dist/tools.json", import.meta.url);
  if (!existsSync(file)) return; // written by npm run build
  const json = JSON.parse(readFileSync(file, "utf8"));
  const listed = ((await request("tools/list"))?.result as { tools: unknown[] }).tools;
  assert.deepEqual(json.tools, JSON.parse(JSON.stringify(listed)));
  assert.equal(json.instructions, INSTRUCTIONS);
});

test("where the iOS Simulator can't run, every tool that needs it says so and how to get a cloud phone; cloud and jobs still answer", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const hint = process.env.SIMULATOR_USE_NO_CLOUD_HINT;
  delete process.env.SIMULATOR_USE_NO_CLOUD_HINT;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const want = "This machine can't run the iOS Simulator: it needs a Mac with Xcode.\nNext: cloud start runs every tool on a NoMac cloud iPhone Simulator, $0.80 an hour by the minute (https://nomac.app/?utm_source=simulator-use); then call this again. Or: run simulator-use on a Mac with Xcode.";
    for (const [name, args] of [["app_run", { path: "." }], ["tests_run", { path: "." }], ["ui_look", {}], ["devices", {}]] as const) {
      const out = await callTool(name, args as Record<string, unknown>, { waitForJobs: true });
      assert.equal(out.text, want, name);
      assert.equal(out.isError, true);
    }
    assert.match((await callTool("cloud", { action: "status" })).text, /^Cloud is off/);
    assert.doesNotMatch((await callTool("job_status", {})).text, /can't run the iOS Simulator/);
    process.env.SIMULATOR_USE_NO_CLOUD_HINT = "1";
    assert.equal((await callTool("app_run", { path: "." })).text, "This machine can't run the iOS Simulator: it needs a Mac with Xcode.\nNext: Run simulator-use on a Mac with Xcode.");
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (hint === undefined) delete process.env.SIMULATOR_USE_NO_CLOUD_HINT;
    else process.env.SIMULATOR_USE_NO_CLOUD_HINT = hint;
  }
});

test("a Mac without Xcode (or with the Command Line Tools alone) says so before a build tool's error", { skip: process.platform !== "darwin" }, async () => {
  const developer = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = "/Library/Developer/CommandLineTools-or-nothing";
  try {
    const out = await callTool("app_run", { path: "." }, { waitForJobs: true });
    assert.match(out.text, /^This Mac has no Xcode, so it can't run the iOS Simulator \(the Command Line Tools alone have none\)\.\nNext: cloud start runs every tool on a NoMac cloud iPhone Simulator/);
    assert.match(out.text, /Or: install Xcode from the App Store and open it once\.$/);
  } finally {
    if (developer === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = developer;
  }
});
