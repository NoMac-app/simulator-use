#!/usr/bin/env node
// Turns the raw results of one run (bench/results/<date>/<tool>.json) into summary.json, summary.md and the HTML
// table rows the benchmarks page uses.
//   node bench/summarize.mjs bench/results/2026-10-31
// Tokens: with ANTHROPIC_API_KEY set (and `npm install @anthropic-ai/sdk` in bench/), text is counted with
// Anthropic's token counting API (model claude-opus-5-5); without it, characters / 4. Images are width * height / 750
// after the scaling the API applies (2576 px long edge, about 4784 tokens at most).
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageTokens, median, p90, textTokensProxy } from "./lib/measure.mjs";
import { hydrate } from "./lib/dedup.mjs";

const dir = process.argv[2];
if (!dir) { console.error("usage: summarize.mjs RESULTS_DIR"); process.exit(2); }
// A large results file is kept gzipped (<tool>.json.gz); both forms are read.
const isRun = (f) => /\.json(\.gz)?$/.test(f) && !/\.tools\.json$/.test(f) && !f.startsWith("summary") && f !== "token-cache.json" && f !== "macs.json";
const load = (f) => JSON.parse(f.endsWith(".gz") ? gunzipSync(readFileSync(join(dir, f))).toString("utf8") : readFileSync(join(dir, f), "utf8"));
const runs = readdirSync(dir).filter(isRun).map((f) => hydrate(load(f)));

// ---- token counting ---------------------------------------------------------------------------------------------
const MODEL = "claude-opus-5-5";
let client = null;
if (process.env.ANTHROPIC_API_KEY) {
  try { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
  catch { console.error("ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed; using characters / 4"); }
}
const method = client ? `Anthropic token counting API (${MODEL})` : "characters / 4 (no ANTHROPIC_API_KEY was set)";
const cacheFile = join(dir, "token-cache.json");
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
let baseline = null;
async function countMessage(text) {
  const r = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: text }] });
  return r.input_tokens;
}
async function textTokens(text) {
  if (!text) return 0;
  if (!client) return textTokensProxy(text.length);
  const key = `${MODEL}:${createHash("sha256").update(text).digest("hex")}`;
  if (cache[key] === undefined) {
    baseline ??= await countMessage(".");
    cache[key] = Math.max(0, (await countMessage(text)) - baseline);
  }
  return cache[key];
}
async function toolDefTokens(tools, instructions) {
  const defs = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema ?? { type: "object" } }));
  if (!client) return { definitions: textTokensProxy(JSON.stringify(defs).length), instructions: textTokensProxy(instructions.length) };
  const base = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: "." }] });
  const withTools = defs.length ? await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: "." }], tools: defs }) : base;
  const withInstr = instructions ? await client.messages.countTokens({ model: MODEL, system: instructions, messages: [{ role: "user", content: "." }] }) : base;
  return { definitions: withTools.input_tokens - base.input_tokens, instructions: withInstr.input_tokens - base.input_tokens };
}
async function callTokens(c) {
  const images = (c.images ?? []).reduce((s, i) => s + imageTokens(i.w, i.h), 0);
  return { text: await textTokens(c.text ?? ""), images, files: await textTokens(c.fileText ?? ""), get total() { return this.text + this.images + this.files; } };
}
async function opTokens(op) {
  let total = 0, images = 0, files = 0;
  for (const c of op.calls ?? []) { const t = await callTokens(c); total += t.total; images += t.images; files += t.files; }
  return { total, images, files };
}

// ---- per tool ---------------------------------------------------------------------------------------------------
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
async function metric(run, kind) {
  const ops = run.ops.filter((o) => o.op === kind);
  if (!ops.length) return null;
  const ok = ops.filter((o) => o.ok);
  const toks = []; const imgs = []; const fileToks = [];
  for (const o of ok) { const t = await opTokens(o); toks.push(t.total); imgs.push(t.images); fileToks.push(t.files); }
  const errors = {};
  for (const o of ops.filter((o) => !o.ok)) { const e = (o.error ?? "").replace(/\s+/g, " ").slice(0, 240); errors[e] = (errors[e] ?? 0) + 1; }
  return {
    n: ops.length, ok: ok.length,
    medianMs: r1(median(ok.map((o) => o.ms))), p90Ms: r1(p90(ok.map((o) => o.ms))), minMs: r1(Math.min(...ok.map((o) => o.ms))), maxMs: r1(Math.max(...ok.map((o) => o.ms))),
    medianTokens: median(toks), medianImageTokens: median(imgs), medianFileTokens: median(fileToks),
    callsPerOp: median(ok.map((o) => o.calls.length)),
    medianChars: median(ok.map((o) => o.calls.reduce((s, c) => s + (c.chars ?? 0) + (c.fileChars ?? 0), 0))),
    // The answer, or the file it names for the agent to open, holds the new status text.
    reportsChange: kind === "tap" ? ok.filter((o) => o.calls.some((c) => /Invalid email or password/.test(`${c.text ?? ""}\n${c.fileText ?? ""}`))).length : undefined,
    returnsImage: kind === "tap" ? ok.filter((o) => o.verify?.returnsImage).length : undefined,
    errors,
  };
}

// Which Mac ran each run (macs.json: time ranges), when a run spans more than one Mac.
const macs = existsSync(join(dir, "macs.json")) ? JSON.parse(readFileSync(join(dir, "macs.json"), "utf8")) : {};
const macOf = (run) => Object.entries(macs).find(([k, m]) => typeof m === "object" && run.startedAt >= m.from && run.startedAt <= m.to)?.[0] ?? null;

const tools = [];
for (const run of runs) {
  const listFile = [join(dir, `${run.tool}${run.label ? `.${run.label}` : ""}.tools.json`), join(dir, `${run.tool}.tools.json`)].find((f) => existsSync(f)) ?? "";
  const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : { tools: [], instructions: "" };
  const defTokens = await toolDefTokens(list.tools, list.instructions ?? "");
  const setup = run.ops.find((o) => o.op === "setup");
  const warm = run.ops.find((o) => o.op === "warmup");
  tools.push({
    tool: run.tool, label: run.label ?? null, condition: run.condition ?? null, name: run.name, mac: macOf(run), interface: run.interface, version: run.version, fatal: run.fatal ?? null, notes: run.notes,
    toolList: run.interface === "cli"
      ? { count: 0, definitionsTokens: 0, instructionsTokens: 0, totalTokens: 0, note: "command line, no MCP server" }
      : { count: run.server?.toolCount ?? 0, definitionsTokens: defTokens.definitions, instructionsTokens: defTokens.instructions, totalTokens: defTokens.definitions + defTokens.instructions, startToListMs: r1(run.server?.startToListMs) },
    cold: { setupMs: r1(setup?.ms), setupOk: setup?.ok ?? null, setupError: setup?.error ?? null, firstReadMs: r1(warm?.ms), firstReadOk: warm?.ok ?? null, firstReadError: warm?.error ?? null },
    read: await metric(run, "read"), tap: await metric(run, "tap"), type: await metric(run, "type"),
    flow: await metric(run, "flow"), flowBatch: await metric(run, "flow-batch"),
    environment: run.environment, startedAt: run.startedAt, finishedAt: run.finishedAt,
  });
}
if (client) writeFileSync(cacheFile, JSON.stringify(cache));

// The leaderboard: every tool that finished the sign-in flow, fastest median first; the rest after, by name.
const flowMs = (t) => (t.flow?.ok ? t.flow.medianMs : Infinity);
tools.sort((a, b) => flowMs(a) - flowMs(b) || a.name.localeCompare(b.name));
const summary = { generatedAt: new Date().toISOString(), tokenMethod: method, imageRule: "width * height / 750 after scaling to at most 2576 px on the long edge and about 4784 tokens", tools };
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));

// ---- markdown and HTML rows ---------------------------------------------------------------------------------------
const s = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const n = (x) => (x === null || x === undefined ? "n/a" : Math.round(x).toLocaleString("en-US"));
const okOf = (m) => (m ? `${m.ok}/${m.n}` : "n/a");
const md = [];
md.push(`Tokens: ${method}. Images: ${summary.imageRule}.`, "");
md.push("| Tool | Mac | Sign-in flow (median) | Flow tokens | Flow ok | Read median | Read p90 | Read tokens | Tap median | Tap p90 | Tap reports change | Type median | Tool list tokens |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const t of tools) md.push(`| ${t.name} ${t.version ?? ""} | ${t.mac ?? ""} | ${s(t.flow?.medianMs)} | ${n(t.flow?.medianTokens)} | ${okOf(t.flow)} | ${s(t.read?.medianMs)} | ${s(t.read?.p90Ms)} | ${n(t.read?.medianTokens)} | ${s(t.tap?.medianMs)} | ${s(t.tap?.p90Ms)} | ${t.tap ? `${t.tap.reportsChange}/${t.tap.ok}` : "n/a"} | ${s(t.type?.medianMs)} | ${n(t.toolList.totalTokens)} |`);
md.push("", "Batched flow (where the tool has a batch or sequence call):", "", "| Tool | Batched flow (median) | Tokens | ok |", "|---|---|---|---|");
for (const t of tools.filter((t) => t.flowBatch)) md.push(`| ${t.name} (Mac ${t.mac}) | ${s(t.flowBatch.medianMs)} | ${n(t.flowBatch.medianTokens)} | ${okOf(t.flowBatch)} |`);
md.push("", "Failures:", "");
for (const t of tools) for (const k of ["read", "tap", "type", "flow", "flowBatch"]) for (const [e, c] of Object.entries(t[k]?.errors ?? {})) md.push(`- ${t.name} ${k} (${c}x): ${e}`);
for (const t of tools) if (t.fatal) md.push(`- ${t.name}: FATAL ${t.fatal.split("\n")[0]}`);
writeFileSync(join(dir, "summary.md"), md.join("\n") + "\n");
console.log(md.join("\n"));
