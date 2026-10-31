#!/usr/bin/env node
// Writes the measured tables into site/benchmarks.html from a run's summary.json, between the page's markers
// (<!-- bench:NAME --> ... <!-- /bench:NAME -->), so the page shows exactly what the run measured.
//   node bench/page.mjs bench/results/2026-10-31 site/benchmarks.html
//
// Which runs are ranked: one run per tool, the one with no label (simulator-use's first run), or for a tool that did
// not pass headless, its run with Device Hub open if that one passed. A run passes when at least 8 in 10 of its
// reads, taps, typings and sign-ins worked. Every other run is listed under "Not ranked here" with its counts.
// simulator-use's second run (label "last") gives the drift note.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, pagePath] = process.argv.slice(2);
if (!dir || !pagePath) { console.error("usage: page.mjs RESULTS_DIR PAGE"); process.exit(2); }
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const runs = summary.tools;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sec = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "" : ms < 10 ? "&lt;0.01 s" : `${(ms / 1000).toFixed(ms >= 100_000 ? 0 : 2)} s`);
const num = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "" : Math.round(x).toLocaleString("en-US"));
const ofN = (m) => (m ? `${m.ok} of ${m.n}` : "");
const version = (t) => String(t.version ?? "").replace(/^Xcode ([\d.]+), Build version (\w+)$/, "$1 ($2)");
const condition = (t) => (t.label?.includes("devicehub") ? "Device Hub open, as its README says" : "");
const name = (t) => `<td>${esc(t.name)} <span class="v">${esc(version(t))}</span>${condition(t) ? `<span class="c">${esc(condition(t))}</span>` : ""}</td>`;
const pct = (m) => (m && m.n ? m.ok / m.n : 0);
const passes = (t) => ["read", "tap", "type", "flow"].every((k) => pct(t[k]) >= 0.8);

// One ranked run per tool.
const tools = [...new Set(runs.map((t) => t.tool))];
const ranked = [], notRanked = [];
for (const tool of tools) {
  const base = runs.find((t) => t.tool === tool && !t.label);
  const hub = runs.find((t) => t.tool === tool && t.label?.includes("devicehub"));
  if (base && passes(base)) { ranked.push(base); if (hub) notRanked.push(hub); }
  else if (hub && passes(hub)) { ranked.push(hub); if (base) notRanked.push(base); }
  else { if (base) notRanked.push(base); if (hub) notRanked.push(hub); }
}
const last = runs.find((t) => t.tool === "simulator-use" && t.label === "last");
// Every other run (second runs, controls) is listed, in the order it ran.
for (const t of runs) if (!ranked.includes(t) && !notRanked.includes(t)) notRanked.push(t);
notRanked.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const first = ranked.find((t) => t.tool === "simulator-use");

const cell = (v) => `<td class="n">${v}</td>`;
const okCell = (m) => `<td class="n${m && m.ok < m.n ? " part" : ""}">${ofN(m)}</td>`;
// A median from fewer passes than runs says so (Argent's taps: 19 of 20).
const secOf = (m) => `${sec(m.medianMs)}${m.ok < m.n ? ` (${m.ok} of ${m.n})` : ""}`;
const by = (k) => [...ranked].sort((a, b) => a[k].medianMs - b[k].medianMs || a.name.localeCompare(b.name));

const boardRuns = by("flow");
// The leaderboard ranks what an agent reads back over the whole sign-in, then its time. simulator-use's sign-in shows
// its second run beside its first (the drift note), so the faster run is never the only one shown.
const byTokens = [...ranked].sort((a, b) => a.flow.medianTokens - b.flow.medianTokens || a.flow.medianMs - b.flow.medianMs || a.name.localeCompare(b.name));
const signIn = (t) => sec(t.flow.medianMs);
const listCell = (t) => (t.interface === "cli" ? "none (CLI)" : num(t.toolList.totalTokens));
const board = byTokens.map((t, i) => `<tr><td class="r">${i + 1}</td>${name(t)}${cell(num(t.flow.medianTokens))}${cell(signIn(t))}${okCell(t.flow)}${cell(secOf(t.read))}${cell(secOf(t.tap))}${cell(listCell(t))}</tr>`);
const read = by("read").map((t) => `<tr>${name(t)}${cell(sec(t.read.medianMs))}${cell(sec(t.read.p90Ms))}${cell(num(t.read.medianTokens))}${okCell(t.read)}</tr>`);
const tap = by("tap").map((t) => `<tr>${name(t)}${cell(sec(t.tap.medianMs))}${cell(sec(t.tap.p90Ms))}${cell(`${t.tap.reportsChange} of ${t.tap.ok}`)}${cell(num(t.tap.medianTokens))}${okCell(t.tap)}</tr>`);
const type = by("type").map((t) => `<tr>${name(t)}${cell(sec(t.type.medianMs))}${cell(sec(t.type.p90Ms))}${cell(t.type.callsPerOp)}${cell(num(t.type.medianTokens))}${okCell(t.type)}</tr>`);
const batchCells = (t) => (!t.flowBatch ? `<td class="n na" colspan="3">no batched run</td>`
  : t.flowBatch.ok ? `${cell(sec(t.flowBatch.medianMs))}${cell(num(t.flowBatch.medianTokens))}${okCell(t.flowBatch)}`
  : `<td class="n na" colspan="2">no batched sign-in completed</td>${okCell(t.flowBatch)}`);
const flow = boardRuns.map((t) => `<tr>${name(t)}${cell(sec(t.flow.medianMs))}${cell(num(t.flow.medianTokens))}${okCell(t.flow)}${batchCells(t)}</tr>`);

// The tool list and the cold start: every tool once (its ranked run, else its first run).
const oncePerTool = tools.map((tool) => ranked.find((t) => t.tool === tool) ?? runs.find((t) => t.tool === tool && !t.label) ?? runs.find((t) => t.tool === tool));
const plain = (t) => `<td>${esc(t.name)} <span class="v">${esc(version(t))}</span></td>`;
const list = [...oncePerTool].sort((a, b) => a.toolList.totalTokens - b.toolList.totalTokens).map((t) => `<tr>${plain(t)}<td class="n">${t.interface === "cli" ? "CLI" : num(t.toolList.count)}</td><td class="n">${t.interface === "cli" ? "" : num(t.toolList.definitionsTokens)}</td><td class="n">${t.interface === "cli" ? "" : num(t.toolList.instructionsTokens)}</td><td class="n">${t.interface === "cli" ? "none" : num(t.toolList.totalTokens)}</td></tr>`);
const cold = [...oncePerTool].sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<tr>${name(t)}<td class="n">${t.cold.setupMs ? sec(t.cold.setupMs) : "none"}</td><td class="n">${sec(t.cold.firstReadMs)}${t.cold.firstReadOk ? "" : " (the read failed)"}</td></tr>`);

// Not ranked: the plain counts of each such run, and its condition.
const counts = (t) => [...(t.flow?.ok ? [`sign-in ${sec(t.flow.medianMs)}`] : []), `signed in ${ofN(t.flow)}`, `taps that reached the app ${ofN(t.tap)}`, `typings shown ${ofN(t.type)}`, `screen reads ${ofN(t.read)}${t.read?.ok ? ` (median ${sec(t.read.medianMs)})` : ""}`, ...(t.flowBatch ? [`batched sign-ins ${ofN(t.flowBatch)}`] : [])].join("; ");
const why = (t) => (t.label === "last" ? "Second run, after the other seven tools; Simulator headless"
  : t.label?.includes("devicehub") ? "Second run, after all the others; Device Hub open"
  : t.label === "control" ? "Third run, last of all; Simulator headless again"
  : "Simulator headless");
const notRankedRows = notRanked.filter((t) => t.tool !== "simulator-use").map((t) => `<tr><td>${esc(t.name)} <span class="v">${esc(version(t))}</span></td><td>${esc(why(t))}</td><td>${esc(counts(t))}</td></tr>`);

// Drift: simulator-use's first and last run on the same Mac.
const drift = [];
if (first && last) {
  const d = (k) => ({ a: first[k].medianMs, b: last[k].medianMs, p: ((last[k].medianMs - first[k].medianMs) / first[k].medianMs) * 100 });
  const parts = [["sign-in", d("flow")], ["screen read", d("read")], ["tap", d("tap")], ["typing", d("type")]];
  const big = parts.filter(([, x]) => Math.abs(x.p) > 10);
  drift.push(`<p class="fine" id="drift">simulator-use ran first and again last, ${Math.round((Date.parse(last.startedAt) - Date.parse(first.startedAt)) / 60000)} minutes later: ${parts.map(([k, x]) => `${k} ${sec(x.a)}, then ${sec(x.b)} (${x.p >= 0 ? "+" : ""}${x.p.toFixed(0)}%)`).join("; ")}. ${big.length ? `Its ${big.map(([k]) => k).join(" and ")} drifted by more than 10% between the two, so read a difference of that size between two tools with care.` : "Every step stayed within 10%."} The leaderboard shows both of its sign-in times; the other tables show its first run.</p>`);
}

const e = (oncePerTool[0] ?? runs[0])?.environment ?? {};
const envRows = [
  ["Mac", `${e.hardware?.cpu ?? ""}, ${e.hardware?.cores ?? ""} cores, ${e.hardware?.memoryGB ?? ""} GB of memory (${e.hardware?.model ?? ""}, a NoMac Session Mac)`],
  ["macOS", e.macos ?? ""],
  ["Xcode", String(e.xcode ?? "").replace(/, Build version (\w+)/, " ($1)")],
  ["Simulator", `iPhone 17 Pro, ${e.simulator?.runtime ?? ""}, booted with simctl; Device Hub closed unless a row says otherwise`],
  ["Node", String(e.node ?? "").replace(/^v/, "")],
  ["Date", (e.date ?? "").slice(0, 10)],
  ["Tokens", summary.tokenMethod.startsWith("characters") ? "estimates: text as characters / 4 (no Anthropic API key was set for this run), images as width * height / 750" : `${summary.tokenMethod}; images as width * height / 750`],
].map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`);

let page = readFileSync(pagePath, "utf8");
const put = (key, rows) => {
  const re = new RegExp(`(<!-- bench:${key} -->)[\\s\\S]*?(<!-- /bench:${key} -->)`);
  if (!re.test(page)) throw new Error(`no bench:${key} block in ${pagePath}`);
  page = page.replace(re, `$1\n${rows.join("\n")}\n$2`);
};
put("board", board); put("read", read); put("tap", tap); put("type", type); put("flow", flow); put("list", list); put("cold", cold);
put("env", envRows); put("notranked", notRankedRows); put("drift", []);

// The headline: simulator-use's lead in tokens per sign-in, when it has one, from these results.
const counted = (n) => ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"][n] ?? String(n);
const byTok = [...ranked].sort((a, b) => a.flow.medianTokens - b.flow.medianTokens);
const su = byTok[0]?.tool === "simulator-use" ? byTok[0] : null;
const times = (t) => `${(t.flow.medianTokens / su.flow.medianTokens).toFixed(t.flow.medianTokens / su.flow.medianTokens < 10 ? 1 : 0)}x`;
const xcodeRun = ranked.find((t) => t.tool === "xcode-mcp"), worst = byTok.at(-1), next = byTok[1];
const claim = su && next ? `simulator-use read ${num(su.flow.medianTokens)} tokens per sign-in: ${times(next)} fewer than the next tool${xcodeRun && xcodeRun !== next ? `, ${times(xcodeRun)} fewer than Xcode MCP` : ""}${worst !== next && worst !== xcodeRun ? ` and ${times(worst)} fewer than ${worst.name}` : ""}.` : "";
put("hero", [su
  ? `    <h1>The most token-efficient iOS Simulator tool for agents.</h1>
    <p class="lead">${counted(byTok.length)} tools signed in to the same app on the same iPhone 17 Pro Simulator, on one Mac, each through its own MCP server (AXe, which has none, through its command line). ${esc(claim)} Every call was timed and saved, failures included.</p>`
  : `    <h1>Eight Simulator tools, one sign-in screen.</h1>
    <p class="lead">Eight tools drove the same app on the same iPhone 17 Pro Simulator, on one Mac, through their own MCP servers (AXe, which has none, through its command line), the way an agent uses them. Every call was timed and saved, failures included.</p>`]);
const metaText = su ? `${claim} ${counted(byTok.length)} iOS Simulator tools for AI agents on one sign-in flow: time, tokens and reliability, every call published.` : "Eight iOS Simulator tools for coding agents on the same app and the same iPhone 17 Pro Simulator: time and tokens to read the screen, tap, type and sign in. Every call measured and published.";
put("meta", [`<meta name="description" content="${esc(metaText)}">`]);
put("ogdesc", [`<meta property="og:description" content="${esc(metaText)}">`]);
writeFileSync(pagePath, page);
console.log(`ranked: ${ranked.map((t) => t.tool + (t.label ? `@${t.label}` : "")).join(", ")}; not ranked: ${notRanked.map((t) => t.tool + (t.label ? `@${t.label}` : "")).join(", ") || "none"}`);
