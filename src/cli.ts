/**
 * The command line, built from the same tool list as the MCP server:
 * `simulator-use look --find "Sign In"` calls ui_look with { find: "Sign In" }.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { persistCloud } from "./cloud/account.ts";
import { shellWord } from "./engine/apps.ts";
import { onSignalExit } from "./engine/jobs.ts";
import { persistHeld } from "./engine/state.ts";
import { serve } from "./mcp.ts";
import { callTool, toContent, TOOLS, VERSION } from "./registry.ts";
import { stopServerPhone } from "./tools/cloud.ts";
import type { Tool } from "./tools/types.ts";
import { relay, relayPorts } from "./tunnel-relay.ts";

const flag = (name: string) => `--${name.replace(/_/g, "-")}`;

/** Parses `--name value` and `--switch` into arguments the tool's schema accepts. */
export function parseArgs(tool: Tool, argv: string[]): Record<string, unknown> | string {
  const props = tool.inputSchema.properties;
  const args: Record<string, unknown> = {};
  const list = Object.entries(props).find(([, p]) => p.type === "array")?.[0];
  const words = [...(tool.positional ?? [])];
  // After "--" every word is a bare word, one that starts with "--" too: `simulator-use app launch -- --uitesting`.
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (options && raw === "--") {
      options = false;
      continue;
    }
    if (!options || !raw.startsWith("--")) {
      // Bare words fill the tool's positional arguments in order, then a list argument takes the rest.
      const next = words.find((w) => !(w in args));
      if (next) {
        // The argument that takes the rest is quoted from its first word on, so each word stays one: `-Name "O'Brien"`.
        args[next] = tool.restWords?.(args) === next ? shellWord(raw) : raw;
        continue;
      }
      if (list) {
        args[list] = [...((args[list] as string[] | undefined) ?? []), raw];
        continue;
      }
      const rest = tool.restWords?.(args);
      if (rest && typeof args[rest] === "string") {
        args[rest] = `${args[rest]} ${shellWord(raw)}`;
        continue;
      }
      return `Unexpected "${raw}". ${usage(tool)}`;
    }
    const [name, inline] = raw.startsWith("--") ? raw.slice(2).split(/=(.*)/s, 2) : [undefined, undefined];
    const key = name?.replace(/-/g, "_");
    const prop = key ? props[key] : undefined;
    if (!key || !prop || prop.type === "array") return `Unknown option ${raw}. ${usage(tool)}`;
    if (prop.type === "boolean") {
      args[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) return `${flag(key)} needs a value.`;
    args[key] = prop.type === "number" ? Number(value) : value;
  }
  return args;
}

/** Options only the command line has, beside the tool's own. */
const CLI_OPTIONS: Record<string, [string, string][]> = {
  ui_look: [["--out <file>", "Save the screen to this file: a .jpg sized to points (to read), or a .png at full resolution (a store, a report)"]],
};

export function usage(tool: Tool): string {
  const entries = Object.entries(tool.inputSchema.properties);
  const bare = (tool.positional ?? []).map((key) => ` [${key}]`).join("");
  const options = entries.filter(([key, p]) => p.type !== "array" && !tool.positional?.includes(key)).map(([key, p]) => `${flag(key)}${p.type === "boolean" ? "" : ` <${p.type}>`}`);
  options.push(...(CLI_OPTIONS[tool.name] ?? []).map(([name]) => name));
  const words = entries.filter(([, p]) => p.type === "array").map(([key]) => ` <${key}...>`).join("");
  return `Usage: simulator-use ${tool.command}${bare}${options.length ? ` [${options.join("] [")}]` : ""}${words}`;
}

const quoteWord = (value: string) => (/^[\w@./:#+=,-]+$/.test(value) ? value : JSON.stringify(value));

/** A hint's MCP arguments (`{device: "X", crashes: true}`) as the command's words and options. */
function commandArgs(tool: Tool, body: string): string[] {
  const words: string[] = [];
  const positional = [...(tool.positional ?? [])];
  for (const [, key, raw] of body.matchAll(/(\w+):\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)) {
    let value: unknown = raw!.trim();
    try {
      value = JSON.parse(value as string);
    } catch {
      // A bare word stays as it is.
    }
    if (positional[0] === key) {
      positional.shift();
      words.push(quoteWord(String(value)));
    } else if (value === true) words.push(flag(key!));
    else words.push(`${flag(key!)}${value === false ? "=false" : ` ${quoteWord(String(value))}`}`);
  }
  return words;
}

/**
 * On the command line a hint names commands, not MCP tools: `device_use {device: "X"}` reads `simulator-use use X`,
 * and "pass device" reads "pass --device". Only "Next:" lines change: other lines can hold the app's own text.
 */
export function forCommandLine(text: string): string {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const options = new Set(TOOLS.flatMap((t) => Object.keys(t.inputSchema.properties)));
  const tools = new RegExp(`\\b(${TOOLS.map((t) => t.name).join("|")})\\b(?:\\s*\\{([^{}]*)\\})?`, "g");
  return text
    .split("\n")
    .map((line) =>
      line.startsWith("Next:")
        ? line
            .replace(tools, (_match, name: string, body?: string) => {
              const tool = byName.get(name)!;
              return ["simulator-use", tool.command, ...(body ? commandArgs(tool, body) : [])].join(" ");
            })
            .replace(/\b([Pp]ass) (\w+)\b/g, (match, verb: string, key: string) => (options.has(key) ? `${verb} ${flag(key)}` : match))
        : line,
    )
    .join("\n");
}

/** The first sentence of a description, ending in one period. */
const summary = (description: string) => `${description.split(/\.\s/)[0]!.replace(/\.$/, "")}.`;

export function help(): string {
  const width = Math.max(...TOOLS.map((t) => t.command.length), 3);
  return [
    `simulator-use ${VERSION}: give your agent a phone.`,
    "",
    "Commands:",
    ...TOOLS.map((t) => `  ${t.command.padEnd(width)}  ${summary(t.description)}`),
    `  ${"mcp".padEnd(width)}  Run the MCP server on stdio.`,
    `  ${"call".padEnd(width)}  Call a tool by its MCP name with JSON arguments and print one JSON line: simulator-use call ui_look '{"find":"Sign In"}'.`,
    "",
    "Examples:",
    "  simulator-use run                      build, install and launch the Xcode project in this folder",
    "  simulator-use look                     read the screen",
    '  simulator-use act "fill #email a@b.co" "tap #signIn" \'wait "Welcome"\'',
    "  simulator-use logs --crashes           why did it crash",
    "",
    "Run simulator-use <command> --help for its options.",
  ].join("\n");
}

/** One command's help: what it does, its words and options with their choices. */
export function commandHelp(tool: Tool): string {
  const lines = [tool.description, "", usage(tool)];
  for (const [key, p] of Object.entries(tool.inputSchema.properties)) {
    const choices = p.type !== "array" && p.enum ? ` (${p.enum.join(", ")})` : "";
    const name = p.type === "array" ? `<${key}...>` : tool.positional?.includes(key) ? `[${key}] or ${flag(key)}` : flag(key);
    lines.push(`  ${name}  ${p.description}${choices}`);
  }
  for (const [name, description] of CLI_OPTIONS[tool.name] ?? []) lines.push(`  ${name}  ${description}`);
  return lines.join("\n");
}

/**
 * look --out FILE, taken out of the command's words: the screen saved where the person names it, a .jpg sized to
 * points (what ui_look's screenshot gives the agent) or a .png at full resolution (its screenshot_file).
 */
export function outOption(tool: Tool, argv: string[]): { argv: string[]; out?: string } | string {
  if (!CLI_OPTIONS[tool.name]) return { argv };
  const rest: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (raw !== "--out" && !raw.startsWith("--out=")) {
      rest.push(raw);
      continue;
    }
    out = raw === "--out" ? argv[++i] : raw.slice("--out=".length);
    if (!out) return "--out needs a file: a .jpg sized to points, or a .png at full resolution.";
  }
  if (out !== undefined && !/\.(jpe?g|png)$/i.test(out)) return `--out takes a .jpg (sized to points, to read) or a .png (full resolution), not ${out}.`;
  return { argv: rest, out };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }
  // The host's tunnel relay for a NoMac phone (not for people): its stdout is the tunnel, so nothing else is printed.
  if (command === "tunnel-relay") {
    try {
      await relay(process.stdin, process.stdout, relayPorts(process.env.SIMULATOR_USE_PORTS));
    } catch (error) {
      console.error(`tunnel-relay: ${(error as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (command === "mcp") {
    // The server's cloud phone is its agent's own: stopped when the server ends, by a signal or below.
    onSignalExit(stopServerPhone);
    await serve();
    // The client closed stdin: answer what was in flight, stop the server's phone, then go, even if a child process
    // still holds a pipe.
    await Promise.race([stopServerPhone().catch(() => undefined), delay(15_000, undefined, { ref: false })]);
    process.exit(0);
  }
  // From here on each command is its own process: the Simulator chosen with `use` and cloud mode are kept in files.
  persistHeld();
  persistCloud();
  if (command === "call") return call(rest);
  const tool = TOOLS.find((t) => t.command === command || t.name === command);
  if (!tool) {
    console.error(`Unknown command "${command}".\n\n${help()}`);
    return 2;
  }
  // Help is asked for before a "--": after it, -h is an app's launch argument like any other.
  const options = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (options.includes("--help") || options.includes("-h")) {
    console.log(commandHelp(tool));
    return 0;
  }
  const taken = outOption(tool, rest);
  const args = typeof taken === "string" ? taken : parseArgs(tool, taken.argv);
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  const saveTo = typeof taken === "string" || !taken.out ? undefined : resolve(taken.out);
  const png = Boolean(saveTo && /\.png$/i.test(saveTo));
  if (saveTo) args[png ? "screenshot_file" : "screenshot"] = true;
  const out = await callTool(tool.name, args, { waitForJobs: true });
  let text = out.text;
  // The full-resolution PNG is in simulator-use's folder (with cloud on, already fetched there): moved where asked.
  const saved = png && !out.isError ? /^screenshot file: (.+)$/m.exec(text)?.[1] : undefined;
  try {
    if (out.image) {
      const file = saveTo && !png ? saveTo : join(tmpdir(), `simulator-use-${Date.now()}.${out.image.mimeType === "image/png" ? "png" : "jpg"}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, out.image.data);
      text += `\nscreenshot: ${file}`;
    }
    if (png && !out.isError) {
      if (!saved || !existsSync(saved)) throw new Error(saved ? `it is at ${saved}` : "the answer named no file");
      await mkdir(dirname(saveTo!), { recursive: true });
      if (saved !== saveTo) {
        await copyFile(saved, saveTo!);
        await unlink(saved).catch(() => undefined);
      }
      text = text.replace(`screenshot file: ${saved}`, () => `screenshot file: ${saveTo}`);
    }
  } catch (error) {
    console.error(`${forCommandLine(text)}\nThe screenshot could not be saved to ${saveTo ?? "a file"}: ${(error as Error).message}.`);
    return 1;
  }
  (out.isError ? console.error : console.log)(forCommandLine(text));
  return out.isError ? 1 : 0;
}

/**
 * `simulator-use call <tool> [json]`: one tool by its MCP name, answered as one line of MCP content
 * ({content, isError}), images as base64, for programs that run simulator-use a call at a time.
 */
async function call([name, json, ...extra]: string[]): Promise<number> {
  const fail = (text: string) => {
    console.log(JSON.stringify(toContent({ text, isError: true })));
    return 2;
  };
  if (!name) return fail(`Usage: simulator-use call <tool> [json]. Tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  if (extra.length) return fail("simulator-use call takes one JSON object of arguments; quote it as one word.");
  let args: unknown = {};
  if (json !== undefined) {
    try {
      args = JSON.parse(json);
    } catch (error) {
      return fail(`The arguments are not JSON: ${(error as Error).message}.`);
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("The arguments must be a JSON object, like {\"find\":\"Sign In\"}.");
  const out = await callTool(name, args as Record<string, unknown>, { waitForJobs: true });
  console.log(JSON.stringify(toContent(out)));
  return out.isError ? 1 : 0;
}
