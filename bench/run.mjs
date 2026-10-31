#!/usr/bin/env node
// Runs the benchmark for one tool on one booted Simulator and writes its raw results as JSON.
//   node bench/run.mjs --tool simulator-use --udid <UDID> --out bench/results/2026-10-31
// Options: --reads 20 --taps 20 --types 10 --flows 10, --no-reboot, --probe (one of each step, printed, nothing saved),
// --label NAME (files <tool>.<NAME>.*, for a second run of a tool), --devicehub (Device Hub open during the run;
// without it, Device Hub is closed so the Simulator runs headless).
// See bench/README.md for the method.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "./lib/mcp.mjs";
import { describeContent, median, p90, callTokens } from "./lib/measure.mjs";
import { AppLog, environment, killMatching, reboot, resetApp, sh, sleep } from "./lib/sim.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const toolId = arg("tool");
const udid = arg("udid");
const outDir = arg("out");
const probe = flag("probe");
const label = arg("label", "");
const deviceHub = flag("devicehub");
const fileBase = label ? `${toolId}.${label}` : toolId;
const N = { reads: Number(arg("reads", 20)), taps: Number(arg("taps", 20)), types: Number(arg("types", 10)), flows: Number(arg("flows", 10)) };
if (!toolId || !udid || (!outDir && !probe)) { console.error("usage: run.mjs --tool NAME --udid UDID --out DIR [--probe]"); process.exit(2); }

if (outDir) mkdirSync(outDir, { recursive: true });
const BUNDLE = "dev.simtap.demo";
const EMAIL = "gary@example.com";
const PASSWORD = "secret1";
const adapter = (await import(`./tools/${toolId}.mjs`)).default;
const log = (...a) => console.log(`[${toolId}]`, ...a);

// ---- recording ---------------------------------------------------------------------------------------------
let current = null; // the calls of the operation being measured
const shorten = (v) => JSON.parse(JSON.stringify(v ?? {}, (k, x) => (typeof x === "string" && x.length > 400 ? `${x.slice(0, 400)}…(${x.length} chars)` : x)));
function record(rec) { (current ?? (current = [])).push(rec); return rec; }

class StepError extends Error {}

const ctx = {
  udid, bundleId: BUNDLE, email: EMAIL, password: PASSWORD,
  mcp: null,
  state: {},           // adapter-owned state (session keys, device ids)
  lastRead: "",        // the text of the latest screen the agent has seen, for refs and coordinates
  /** One MCP tool call, timed from request written to answer parsed. Throws StepError when it fails. */
  async call(name, args = {}, { timeoutMs = 120_000, allowError = false } = {}) {
    const r = await ctx.mcp.call(name, args, timeoutMs);
    const d = describeContent(r.content);
    const rec = record({ kind: "mcp", tool: name, args: shorten(args), ms: r.ms, isError: r.isError, error: r.error, timedOut: r.timedOut, text: d.text, chars: d.chars, images: d.images, other: d.other, structuredChars: r.structured ? JSON.stringify(r.structured).length : 0 });
    if (r.isError && !allowError) throw new StepError(`${name} failed: ${(r.error?.message ?? d.text).slice(0, 600)}`);
    return rec;
  },
  /** One command-line call (for a tool that has no MCP server), timed from spawn to exit. */
  async cli(cmd, args, { timeoutMs = 120_000, allowError = false } = {}) {
    const t0 = process.hrtime.bigint();
    const r = await new Promise((resolve) => {
      const { spawn } = globalThis.__cp;
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
      p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // The agent reads what the command prints: stdout, and stderr when it fails.
    const text = r.code === 0 ? r.out : `${r.out}${r.err}`;
    const rec = record({ kind: "cli", tool: `${cmd.split("/").pop()} ${args[0] ?? ""}`.trim(), args: shorten(args), ms, isError: r.code !== 0, exitCode: r.code, text, chars: text.length, images: [], stderrChars: r.err.length });
    if (r.code !== 0 && !allowError) throw new StepError(`${cmd} ${args.join(" ")} exited ${r.code}: ${(r.err || r.out).slice(0, 600)}`);
    return rec;
  },
  /** A file the tool answers with a path to, which the agent must open to see the screen (counted in its tokens). */
  attachFile(rec, text) { rec.fileChars = (rec.fileChars ?? 0) + text.length; rec.fileText = text; },
};
globalThis.__cp = await import("node:child_process");

async function measure(kind, i, fn) {
  current = [];
  const t0 = process.hrtime.bigint();
  let error = null, out;
  // A failed call, or a read that lacks the element to act on, is the tool's failure; anything else is the harness's.
  try { out = await fn(); } catch (e) { error = e instanceof StepError || e?.name === "TargetError" ? e.message : `harness: ${e.stack ?? e}`; }
  const calls = current; current = null;
  const op = { op: kind, i, ok: !error, error, wallMs: Number(process.hrtime.bigint() - t0) / 1e6, ms: calls.reduce((s, c) => s + c.ms, 0), calls };
  op.tokens = calls.reduce((s, c) => s + callTokens(c).total, 0);
  return { op, out };
}

// ---- the run -------------------------------------------------------------------------------------------------
const results = { tool: toolId, label: label || null, name: adapter.name, interface: adapter.kind, startedAt: new Date().toISOString(), counts: N, notes: [...(adapter.notes ?? [])], ops: [] };
const push = (op) => { results.ops.push(op); return op; };
const say = (op) => log(`${op.op}${op.i !== undefined ? ` #${op.i}` : ""}: ${op.ok ? "ok" : "FAIL"} ${op.ms.toFixed(0)} ms, ${op.tokens} tok${op.error ? ` (${op.error.slice(0, 200)})` : ""}${op.verify ? ` ${JSON.stringify(op.verify)}` : ""}`);

// Nothing of another tool may still run: their servers, daemons and helpers (paths under $BENCH_TOOLS, or names).
const LEFTOVERS = ["bench-tools/bin/", "bench-tools/lib/node_modules/", "bench-tools/maestro/", "maestro.cli", "mobilecli", "devicekit", "AgentDeviceRunner", "simulator-server", "ax-service", "simulator-use-engine", "mcpbridge", "axe describe-ui", "axe tap", "axe type", "axe batch", "hid-broker"];
const stale = killMatching(LEFTOVERS);
if (stale.length) log(`killed ${stale.length} leftover processes: ${stale.join(" | ").slice(0, 600)}`);
if (adapter.prepare) adapter.prepare(ctx);
if (!flag("no-reboot")) { log("rebooting the Simulator"); await reboot(udid); }
// Device Hub (Xcode 27's Simulator app): open only for a --devicehub run, closed otherwise.
const hubRunning = () => sh("pgrep", ["-x", "DeviceHub"], { allowFail: true }).status === 0;
if (deviceHub) { sh("open", ["-a", "DeviceHub"], { allowFail: true }); await sleep(8000); }
else if (hubRunning()) {
  sh("osascript", ["-e", 'quit app "DeviceHub"'], { allowFail: true });
  for (let i = 0; i < 20 && hubRunning(); i++) { if (i === 5) sh("killall", ["-9", "DeviceHub"], { allowFail: true }); await sleep(500); }
  await sleep(2000);
}
results.condition = { deviceHubAsked: deviceHub, deviceHubRunning: hubRunning(), simulator: deviceHub ? "Device Hub open" : "headless (simctl boot, no Device Hub)" };
log("condition", JSON.stringify(results.condition));
await resetApp(udid, BUNDLE, 3000);
results.environment = environment(udid);
results.version = adapter.version ? adapter.version() : null;
log("version", results.version);
let appLog = new AppLog(udid, BUNDLE);
await sleep(1500);

let failed = 0;
try {
  if (adapter.kind === "mcp") {
    const spec = adapter.server(ctx);
    const startT = process.hrtime.bigint();
    ctx.mcp = new McpClient({ ...spec, name: toolId, stderrFile: outDir ? join(outDir, `${fileBase}.stderr.log`) : undefined });
    const init = await ctx.mcp.initialize(180_000);
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    const list = await ctx.mcp.listTools(180_000);
    if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
    const defs = list.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema ?? {} }));
    const instructions = init.result?.instructions ?? "";
    results.server = {
      startToListMs: Number(process.hrtime.bigint() - startT) / 1e6, initMs: init.ms, listMs: list.ms,
      protocolVersion: init.result?.protocolVersion, serverInfo: init.result?.serverInfo,
      toolCount: list.tools.length, toolNames: list.tools.map((t) => t.name),
      definitionsChars: JSON.stringify(defs).length, instructionsChars: instructions.length,
      outputSchemaChars: JSON.stringify(list.tools.map((t) => t.outputSchema ?? null)).length,
      env: spec.env ? Object.keys(spec.env) : [], command: [spec.command.split("/").pop(), ...(spec.args ?? [])].join(" "),
    };
    if (outDir) writeFileSync(join(outDir, `${fileBase}.tools.json`), JSON.stringify({ instructions, tools: list.tools }, null, 1));
    log(`server: ${list.tools.length} tools, ${results.server.definitionsChars} chars of definitions, ${instructions.length} chars of instructions`);
  } else {
    results.server = { toolCount: 0, definitionsChars: 0, instructionsChars: 0, note: "command line, no MCP server" };
  }

  // Setup the tool's docs ask for before the first action (sessions, device selection). Not part of any metric.
  say(push((await measure("setup", undefined, () => adapter.setup?.(ctx))).op));
  // A setup may boot the Simulator again (Argent's does), which ends the log stream: start it again. Then the same
  // fresh app for every tool, as before every other step (a setup can leave another app in front: mobile-mcp's
  // on-device agent leaves the Home Screen).
  appLog.stop(); appLog = new AppLog(udid, BUNDLE);
  await resetApp(udid, BUNDLE, 3000);
  if (adapter.reset) { await adapter.reset(ctx); current = null; await sleep(1500); }

  // A fresh app before each step: simctl terminate and launch, or the tool's own restart where its docs say the agent
  // restarts apps through it (adapter.reset). Untimed, like the read before a tap or a type.
  const reset = async () => { if (adapter.reset) { await adapter.reset(ctx); current = null; await sleep(1500); } else await resetApp(udid, BUNDLE); };

  const doRead = async (kind, i) => {
    const { op, out } = await measure(kind, i, () => adapter.read(ctx));
    if (op.ok) {
      ctx.lastRead = out ?? op.calls.map((c) => c.fileText ?? c.text).join("\n");
      const seen = ctx.lastRead;
      // The Sign In screen: its title and button. (Not "Email": after typing, a field may show its value instead.)
      op.verify = { sawSignIn: /Sign In/.test(seen), sawEmail: /Email/i.test(seen) };
      if (!op.verify.sawSignIn) { op.ok = false; op.error = "the read did not show the Sign In screen"; }
    }
    return op;
  };

  // (1) warm-up, then reads
  say(push(await doRead("warmup")));
  if (probe) log("READ:\n" + ctx.lastRead.slice(0, 1500));
  for (let i = 0; i < (probe ? 2 : N.reads); i++) { const op = push(await doRead("read", i)); if (!probe) say(op); else say(op); }

  // (2) taps: reset the app, look (untimed), tap Sign In with empty fields; the app logs "sign-in rejected".
  const fresh = async () => { await reset(); const pre = await doRead("pre-read"); return pre; };
  for (let i = 0; i < (probe ? 1 : N.taps); i++) {
    const pre = await fresh();
    if (!pre.ok) { push({ ...pre, op: "tap", i, error: `could not read before the tap: ${pre.error}` }); say(results.ops.at(-1)); continue; }
    const mark = appLog.mark();
    const { op } = await measure("tap", i, () => adapter.tap(ctx, "signIn"));
    op.prep = pre;
    const line = await appLog.waitFor(/sign-in rejected/, mark, 5000);
    const answer = op.calls.map((c) => c.text).join("\n");
    op.verify = { appSawTap: Boolean(line), reportsChange: /Invalid email or password/.test(answer), returnsImage: op.calls.some((c) => c.images.length) };
    if (op.ok && !line) { op.ok = false; op.error = "the app logged no Sign In within 5 s"; }
    say(push(op));
    if (probe) log("TAP ANSWER:\n" + answer.slice(0, 3000));
  }

  // (3) type into the Email field after a fresh start; verified by the tool's own read afterwards (untimed).
  for (let i = 0; i < (probe ? 1 : N.types); i++) {
    const pre = await fresh();
    if (!pre.ok) { push({ ...pre, op: "type", i, error: `could not read before typing: ${pre.error}` }); say(results.ops.at(-1)); continue; }
    const { op } = await measure("type", i, () => adapter.type(ctx, "email", EMAIL));
    op.prep = pre;
    if (adapter.actionsReturnScreen && op.ok) ctx.lastRead = op.calls.at(-1).text;
    const after = await doRead("post-read");
    op.post = after;
    op.verify = { fieldShowsText: after.ok && ctx.lastRead.includes(EMAIL) };
    if (op.ok && !op.verify.fieldShowsText) { op.ok = false; op.error = "the field did not show the typed text afterwards"; }
    say(push(op));
    if (probe) log("TYPE ANSWER:\n" + op.calls.map((c) => c.text).join("\n").slice(0, 3000));
  }

  // (4) the sign-in flow an agent does: read, type email, type password, tap Sign In, read to see "Welcome".
  const flowVariants = [["flow", false]];
  if (adapter.batch) flowVariants.push(["flow-batch", true]);
  for (const [kind, batched] of flowVariants) {
    for (let i = 0; i < (probe ? 1 : N.flows); i++) {
      await reset();
      const mark = appLog.mark();
      let finalText = "", finalCalls = [];
      const { op } = await measure(kind, i, async () => {
        const r1 = await adapter.read(ctx);
        ctx.lastRead = r1 ?? current.map((c) => c.fileText ?? c.text).join("\n");
        if (batched) {
          await adapter.batch(ctx, [["type", "email", EMAIL], ["type", "password", PASSWORD], ["tap", "signIn"]]);
        } else {
          for (const [what, field, value] of [["type", "email", EMAIL], ["type", "password", PASSWORD], ["tap", "signIn"]]) {
            const before = current.length;
            if (what === "type") await adapter.type(ctx, field, value); else await adapter.tap(ctx, field);
            if (adapter.actionsReturnScreen) ctx.lastRead = current.at(-1).text || ctx.lastRead;
            if (adapter.refreshAfter?.(current.slice(before))) { const r = await adapter.read(ctx); ctx.lastRead = r ?? current.at(-1).fileText ?? current.at(-1).text; }
          }
        }
        // The last step reads the screen to see "Welcome"; a tool whose read lists no plain text uses the text check
        // its own docs name for that (finalRead).
        const start = current.length;
        const r2 = await (adapter.finalRead ?? adapter.read)(ctx);
        finalCalls = current.slice(start);
        finalText = r2 ?? finalCalls.map((c) => c.fileText ?? c.text).join("\n");
      });
      const line = await appLog.waitFor(/signed in/, mark, 5000);
      const sawWelcome = adapter.welcomeSeen ? adapter.welcomeSeen(finalCalls) : /Welcome, gary@example\.com/.test(finalText);
      op.verify = { sawWelcome, appSignedIn: Boolean(line), calls: op.calls.length };
      if (op.ok && !(op.verify.sawWelcome && op.verify.appSignedIn)) { op.ok = false; op.error = `final read ${op.verify.sawWelcome ? "showed" : "did not show"} Welcome; app ${line ? "signed in" : "did not sign in"}`; }
      say(push(op));
      if (probe) log(`${kind} FINAL READ:\n` + finalText.slice(0, 1500));
    }
  }
} catch (e) {
  failed = 1;
  results.fatal = String(e.stack ?? e);
  log("FATAL", results.fatal);
} finally {
  try { current = []; await adapter.teardown?.(ctx); } catch {}
  current = null;
  if (ctx.mcp) await ctx.mcp.close();
  appLog.stop();
  await sleep(1000);
  results.leftoversKilled = killMatching([...LEFTOVERS, ...(adapter.cleanup ?? [])]);
  results.finishedAt = new Date().toISOString();
  results.mcpNotifications = ctx.mcp?.notifications.length ?? 0;
  results.strayStdout = ctx.mcp?.strayStdout.slice(0, 20) ?? [];
}

// ---- summary for this tool (the page's numbers come from summarize.mjs over every tool) ---------------------------
const by = (k) => results.ops.filter((o) => o.op === k);
const stat = (ops) => ({ n: ops.length, ok: ops.filter((o) => o.ok).length, medianMs: median(ops.filter((o) => o.ok).map((o) => o.ms)), p90Ms: p90(ops.filter((o) => o.ok).map((o) => o.ms)), medianTokens: median(ops.filter((o) => o.ok).map((o) => o.tokens)) });
results.quick = { warmup: stat(by("warmup")), read: stat(by("read")), tap: stat(by("tap")), type: stat(by("type")), flow: stat(by("flow")), flowBatch: stat(by("flow-batch")) };
log("quick", JSON.stringify(results.quick));
if (outDir && !probe) {
  mkdirSync(outDir, { recursive: true });
  results.conditionAtEnd = { deviceHubRunning: hubRunning() };
  writeFileSync(join(outDir, `${fileBase}.json`), JSON.stringify(results, null, 1));
  log(`wrote ${join(outDir, `${fileBase}.json`)}`);
}
process.exit(failed);
