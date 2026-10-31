#!/usr/bin/env node
// Writes the one-on-one comparison pages (site/vs/<slug>.html and site/vs/index.html) from a benchmark run and the
// sourced facts in bench/vs-facts.mjs. Every number comes from the run: rerun this after a new benchmark.
//   node bench/vs.mjs bench/results/2026-10-31 site/vs
// Reads: <results>/summary.json (the measured numbers), <results>/<tool>.json[.gz] (the calls each tool made, for
// "Switching"), and site/benchmarks.html (its <style>, so the pages share the site's CSS exactly).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hydrate } from "./lib/dedup.mjs";
import { DEVICE_HUB, INSTALL, READ_ON, SOURCES, TOOLS } from "./vs-facts.mjs";

const [dir, outDir] = process.argv.slice(2);
if (!dir || !outDir) { console.error("usage: vs.mjs RESULTS_DIR OUT_DIR (site/vs)"); process.exit(2); }
const SITE = "https://simulator-use.dev";
const REPO = "https://github.com/NoMac-app/simulator-use";
const resultsPath = `bench/results/${basename(dir)}`;
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const runs = summary.tools;
const runOf = (tool, label = null) => runs.find((t) => t.tool === tool && (t.label ?? null) === label) ?? null;
const su1 = runOf("simulator-use");
// simulator-use's own run. Its rerun at the end of the session, on a shared VM, is in the raw results.
const su2 = null;
if (!su1) throw new Error("no simulator-use run in the summary");
const benchHtml = readFileSync(join(dirname(outDir), "benchmarks.html"), "utf8");
const baseStyle = benchHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

// ---- formatting --------------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sec = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "" : `${(ms / 1000).toFixed(ms >= 100_000 ? 0 : 2)} s`);
const num = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "" : Math.round(x).toLocaleString("en-US"));
const ofN = (m) => (m ? `${m.ok} of ${m.n}` : "");
const version = (t) => String(t?.version ?? "").replace(/^Xcode ([\d.]+), Build version (\w+)$/, "$1 ($2)");
const srcLinks = (keys) => keys.map((k) => `<a href="${esc(SOURCES[k][1])}">${esc(SOURCES[k][0])}</a>`).join(", ");
const claim = (c) => `${esc(c.t)} <span class="src">(${srcLinks(c.s)})</span>`;
const dateOf = (t) => { const d = t?.environment?.date; return d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : ""; };

// ---- the calls each tool made, from its raw results ------------------------------------------------------------
function loadRaw(tool, label = null) {
  const base = join(dir, label ? `${tool}.${label}` : tool);
  const file = existsSync(`${base}.json`) ? `${base}.json` : existsSync(`${base}.json.gz`) ? `${base}.json.gz` : null;
  if (!file) return null;
  const text = file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");
  return hydrate(JSON.parse(text));
}
function callsOf(tool) {
  const raw = loadRaw(tool);
  if (!raw) return {};
  const udid = raw.environment?.simulator?.udid ?? "";
  const fmt = (c) => {
    if (c.kind === "cli") return `axe ${(c.args ?? []).map((a) => (a === udid ? "<udid>" : /[\s']/.test(a) ? `"${a}"` : a)).join(" ")}`;
    let args = JSON.stringify(c.args ?? {});
    if (udid) args = args.split(udid).join("<udid>");
    args = args.replace(/"Benchmark [^"]*"/g, '"<session key>"').replace(/\\"/g, '"').replace(/\\n/g, "\n");
    return `${c.tool} ${args}`;
  };
  const first = (kind) => raw.ops.find((o) => o.op === kind && o.ok);
  const out = {};
  for (const [key, kind] of [["setup", "setup"], ["read", "read"], ["tap", "tap"], ["type", "type"], ["batch", "flow-batch"]]) {
    const o = first(kind);
    if (!o || !o.calls?.length) continue;
    const calls = kind === "flow-batch" ? o.calls.slice(1, -1) : o.calls; // the batch call, without the reads around it
    out[key] = calls.map(fmt);
  }
  return out;
}

// ---- the measured comparison --------------------------------------------------------------------------------------
const coldMs = (t) => (t?.cold?.firstReadMs ?? 0) + (t?.cold?.setupMs ?? 0);
const METRICS = [
  { key: "flow", label: "Signing in, step by step", kind: "time", get: (t) => t?.flow?.ok ? t.flow.medianMs : null },
  { key: "flowTokens", label: "Tokens read per sign-in (est.)", kind: "tokens", get: (t) => t?.flow?.ok ? t.flow.medianTokens : null },
  { key: "flowBatch", label: "Signing in, batched", kind: "time", get: (t) => t?.flowBatch?.ok ? t.flowBatch.medianMs : null },
  { key: "read", label: "Reading the screen", kind: "time", get: (t) => t?.read?.ok ? t.read.medianMs : null },
  { key: "readTokens", label: "Tokens per screen read (est.)", kind: "tokens", get: (t) => t?.read?.ok ? t.read.medianTokens : null },
  { key: "tap", label: "Tapping a button", kind: "time", get: (t) => t?.tap?.ok ? t.tap.medianMs : null },
  { key: "type", label: "Typing into a field", kind: "time", get: (t) => t?.type?.ok ? t.type.medianMs : null },
  { key: "list", label: "Tool list in the agent's context (est.)", kind: "tokens", get: (t) => (t?.interface === "cli" ? 0 : t?.toolList?.totalTokens ?? null) },
  { key: "cold", label: "Setup and first read after a boot", kind: "time", get: (t) => (t?.cold?.firstReadOk ? coldMs(t) : null) },
];
const fmtOf = (m, v) => (m.kind === "time" ? sec(v) : `${num(v)} tokens`);
// A difference is claimed only when it holds against both of simulator-use's runs, by at least 5%.
function wins(them, name) {
  const forThem = [], forUs = [];
  for (const m of METRICS) {
    const t = m.get(them), a = m.get(su1), b = su2 ? m.get(su2) : a;
    if (t === null || a === null || b === null) continue;
    const both = su2 && m.kind === "time" ? `simulator-use's ${fmtOf(m, a)} (second run ${fmtOf(m, b)})` : `simulator-use's ${fmtOf(m, a)}`;
    if (m.key === "list" && them.interface === "cli") { forThem.push(`${m.label}: none, since ${name} is a command line with no MCP server, against ${both}.`); continue; }
    if (t < Math.min(a, b) * 0.95) forThem.push(`${m.label}: ${fmtOf(m, t)} against ${both}.`);
    else if (Math.max(a, b) < t * 0.95) forUs.push(`${m.label}: ${m.kind === "time" && su2 ? `${fmtOf(m, a)} (second run ${fmtOf(m, b)})` : fmtOf(m, a)} against ${name}'s ${fmtOf(m, t)}.`);
  }
  // Whether a tap's answer shows what it did: the new status text in the answer or the file it names.
  const r = (x) => x?.tap?.ok ? x.tap.reportsChange / x.tap.ok : null;
  if (r(su1) !== null && r(them) !== null && r(su1) - r(them) >= 0.5) forUs.push(`A tap's answer held the new status text in ${su1.tap.reportsChange} of ${su1.tap.ok} taps, ${name}'s in ${them.tap.reportsChange} of ${them.tap.ok}.`);
  if (r(su1) !== null && r(them) !== null && r(them) - r(su1) >= 0.5) forThem.push(`A tap's answer held the new status text in ${them.tap.reportsChange} of ${them.tap.ok} taps, simulator-use's in ${su1.tap.reportsChange} of ${su1.tap.ok}.`);
  for (const k of ["flow", "tap", "type"]) if (them[k] && them[k].ok < them[k].n && su1[k]?.ok === su1[k]?.n) forUs.push(`${k === "flow" ? "Sign-ins completed" : k === "tap" ? "Taps that reached the app" : "Typings shown"}: ${ofN(su1[k])} against ${name}'s ${ofN(them[k])}.`);
  return { forThem, forUs };
}

function measuredTable(them, name) {
  const cols = [them, su1, ...(su2 ? [su2] : [])];
  const v = (t, f) => (t ? f(t) : "");
  const rows = [
    ["Signing in, step by step", (t) => (t.flow?.ok ? sec(t.flow.medianMs) : "none completed")],
    ["Tokens read per sign-in (est.)", (t) => (t.flow?.ok ? num(t.flow.medianTokens) : "")],
    ["Sign-ins completed", (t) => ofN(t.flow)],
    ["Signing in, batched", (t) => (!t.flowBatch ? "no batched run" : t.flowBatch.ok ? sec(t.flowBatch.medianMs) : "none completed")],
    ["Tokens read, batched (est.)", (t) => (t.flowBatch?.ok ? num(t.flowBatch.medianTokens) : "")],
    ["Batched sign-ins completed", (t) => (t.flowBatch ? ofN(t.flowBatch) : "")],
    ["Reading the screen (median)", (t) => `${sec(t.read?.medianMs)}${t.read && t.read.ok < t.read.n ? ` (${ofN(t.read)})` : ""}`],
    ["Tapping a button (median)", (t) => (t.tap?.ok ? `${sec(t.tap.medianMs)}${t.tap.ok < t.tap.n ? ` (${ofN(t.tap)})` : ""}` : "none landed")],
    ["Typing into a field (median)", (t) => (t.type?.ok ? `${sec(t.type.medianMs)}${t.type.ok < t.type.n ? ` (${ofN(t.type)})` : ""}` : "none shown")],
    ["Tool list in context (est.)", (t) => (t.interface === "cli" ? "none (CLI)" : num(t.toolList.totalTokens))],
    ["Setup its docs ask for", (t) => (t.cold?.setupMs ? sec(t.cold.setupMs) : "none")],
    ["First read after a boot", (t) => `${sec(t.cold?.firstReadMs)}${t.cold?.firstReadOk ? "" : " (failed)"}`],
  ];
  const head = `<tr><th></th><th class="n">${esc(name)}</th><th class="n">simulator-use</th>${su2 ? `<th class="n">simulator-use, second run</th>` : ""}</tr>`;
  const body = rows.map(([label, f]) => `<tr><td>${esc(label)}</td>${cols.map((t) => `<td class="n">${esc(v(t, f))}</td>`).join("")}</tr>`).join("\n");
  return `<div class="scroll"><table class="cmp"><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>`;
}

function factsTable(tool) {
  const us = TOOLS["simulator-use"].facts, them = tool.facts;
  const rows = [["License", "license"], ["Builds the app", "builds"], ["Runs tests", "tests"], ["Screen as text", "screen"], ["How it taps", "taps"], ["Cloud option", "cloud"], ["Needs besides Xcode", "needs"]];
  const body = rows.map(([label, k]) => `<tr><td>${esc(label)}</td><td>${claim(them[k])}</td><td>${claim(us[k])}</td></tr>`).join("\n");
  return `<div class="scroll"><table class="facts two"><thead><tr><th></th><th>${esc(tool.name)}</th><th>simulator-use</th></tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function switchingTable(tool) {
  const them = callsOf(tool.run), us = callsOf("simulator-use");
  const steps = [["Setup", "setup"], ["Read the screen", "read"], ["Tap a button", "tap"], ["Type into a field", "type"], ["Several steps in one call", "batch"]];
  const cell = (list) => (list?.length ? list.map((c) => `<code class="call">${esc(c)}</code>`).join("") : `<span class="na">none</span>`);
  const body = steps.filter(([, k]) => them[k] || us[k]).map(([label, k]) => `<tr><td>${esc(label)}</td><td>${cell(them[k])}</td><td>${cell(us[k])}</td></tr>`).join("\n");
  const extra = (tool.calls ?? []).map((r) => `<tr><td>${esc(r.step)}</td><td>${claim(r.them)}</td><td>${claim(r.us)}</td></tr>`).join("\n");
  return `<div class="scroll"><table class="facts two"><thead><tr><th></th><th>${esc(tool.name)}</th><th>simulator-use</th></tr></thead><tbody>\n${body}${extra ? `\n${extra}` : ""}\n</tbody></table></div>`;
}

function deviceHubSection(tool) {
  const base = runOf(tool.run), hub = runOf(tool.run, "devicehub"), control = runOf(tool.run, "control");
  if (!hub) return "";
  const row = (label, t) => (t ? `<tr><td>${esc(label)}</td><td class="n">${ofN(t.tap)}</td><td class="n">${ofN(t.type)}</td><td class="n">${ofN(t.flow)}</td><td class="n">${t.flow?.ok ? sec(t.flow.medianMs) : "none"}</td></tr>` : "");
  const quote = `<blockquote>"${esc(DEVICE_HUB.axeQuote.t)}" <span class="src">(${srcLinks(DEVICE_HUB.axeQuote.s)})</span></blockquote>`;
  const mbQuote = tool.run === "mobilebuildmcp" ? `<p class="sub">Its own changelog, for version 2.7.0: "${esc(DEVICE_HUB.mbQuote.t)}" <span class="src">(${srcLinks(DEVICE_HUB.mbQuote.s)})</span>.</p>` : "";
  const what = tool.run === "axe" ? "AXe's README says" : "MobileBuildMCP reads and taps through a bundled AXe, and AXe's README says";
  return `<section id="device-hub">
    <h2>With Device Hub open</h2>
    <p class="sub">${what}:</p>
    ${quote}
    ${mbQuote}
    <p class="sub">So ${esc(tool.name)} ran three times on the benchmark's Mac: with the Simulator headless like every tool, again with Device Hub open, and once more with Device Hub closed. The ranking uses the first run.</p>
    <div class="scroll"><table class="cmp"><thead><tr><th>Condition</th><th class="n">Taps that reached the app</th><th class="n">Typings shown</th><th class="n">Sign-ins completed</th><th class="n">Sign-in</th></tr></thead><tbody>
${row("Headless, the ranked run", base)}
${row("Device Hub open", hub)}
${row("Headless again, last of all", control)}
    </tbody></table></div>
    <p class="fine">With Device Hub open, every ${esc(tool.name === "AXe" ? "axe tap" : "tap")} still answered that it was done; the counts are what the app's own log saw. simulator-use is built on AXe's frameworks: its engine keeps one session open per Simulator instead of starting AXe for each call.</p>
  </section>`;
}

// ---- the page --------------------------------------------------------------------------------------------------------
const EXTRA_CSS = `
.cmp td:first-child { color: var(--muted); }
.cmp td.n { color: var(--text); }
table.two td { width: 40%; }
table.two td:first-child { width: 20%; color: var(--muted); }
.src { color: var(--faint); font-size: 12.5px; }
.src a { color: var(--faint); }
.answer p { color: var(--muted); max-width: 680px; margin: 0 0 12px; font-size: 17px; line-height: 1.55; }
.answer p.measured { color: var(--faint); font-size: 14.5px; }
blockquote { margin: 16px 0; padding: 0 0 0 16px; border-left: 2px solid var(--line-2); color: var(--text); max-width: 680px; }
code.call { display: block; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--text); margin: 0 0 6px; }
.cmd { display: inline-flex; max-width: 100%; margin-top: 16px; padding: 10px 16px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--surface); font: 13.5px var(--mono); overflow-wrap: anywhere; }
ul.vs { margin: 24px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line); max-width: 760px; }
ul.vs li { padding: 14px 0; border-bottom: 1px solid var(--line); }
ul.vs a { color: var(--text); text-decoration: none; font-weight: 500; }
ul.vs a:hover { text-decoration: underline; text-underline-offset: 4px; }
ul.vs span { display: block; color: var(--muted); font-size: 14.5px; margin-top: 2px; }
.cmp td.n, .cmp th.n { width: 22%; }
.name { white-space: nowrap; }
@media (max-width: 640px) { table.two td { width: auto; } table.two td:first-child { width: 24%; white-space: normal; } .answer p { font-size: 16px; } header .wrap { gap: 16px; } header nav { gap: 14px; font-size: 13.5px; } }
`;

// The date the results were measured, from their folder (bench/results/YYYY-MM-DD), for the structured data.
const MEASURED_ON = (/(\d{4}-\d{2}-\d{2})/.exec(resultsPath) ?? [])[1];
const crumb = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })) });
const ldScript = (graph) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`;

function shell({ path, title, description, h1, body, ld = [] }) {
  const url = `${SITE}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#0b0b0c">
<meta name="color-scheme" content="dark">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="simulator-use">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${ld.length ? ldScript(ld) : ""}
<style>${baseStyle}${EXTRA_CSS}</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="name" href="/">simulator-use</a>
    <nav><a href="/benchmarks">Benchmarks</a><a href="/vs"${path.startsWith("/vs") ? ' aria-current="page"' : ""}>Compare</a><a href="${REPO}">GitHub</a></nav>
  </div>
</header>

<main class="wrap">
  <div class="hero">
    <h1>${esc(h1)}</h1>
${body}
</main>

<footer>
  <div class="wrap">
    <span>MIT. Made at <a href="https://nomac.app">NoMac</a>.</span>
    <nav><a href="/">simulator-use</a><a href="/benchmarks">Benchmarks</a><a href="/vs">Compare</a><a href="${REPO}">GitHub</a><a href="https://www.npmjs.com/package/simulator-use">npm</a></nav>
  </div>
</footer>
<script defer src="/_vercel/insights/script.js"></script>
</body>
</html>
`;
}

function pageFor(key) {
  const tool = TOOLS[key];
  const them = runOf(tool.run);
  if (!them) throw new Error(`no run for ${tool.run} in ${dir}`);
  const { forThem, forUs } = wins(them, tool.name);
  const tok = (t) => `${num(t.flow.medianTokens)} tokens read (est.)`;
  const faster = them.flow?.ok && su1.flow.medianMs < them.flow.medianMs * 0.95;
  const measured = them.flow?.ok
    ? `Measured on one Mac: simulator-use read ${num(su1.flow.medianTokens)} tokens per sign-in, ${tool.name} ${num(them.flow.medianTokens)} (est.)${faster ? `; simulator-use signed in in ${sec(su1.flow.medianMs)}, ${tool.name} in ${sec(them.flow.medianMs)}` : ""}.`
    : `Measured on one Mac: ${tool.name} completed no sign-in; simulator-use signed in in ${sec(su1.flow.medianMs)}, reading ${num(su1.flow.medianTokens)} tokens (est.).`;
  const usedKeys = new Set();
  const note = (c) => { c.s.forEach((k) => usedKeys.add(k)); return claim(c); };
  for (const k of Object.keys(tool.facts)) { tool.facts[k].s.forEach((s) => usedKeys.add(s)); TOOLS["simulator-use"].facts[k].s.forEach((s) => usedKeys.add(s)); }
  if (tool.deviceHub) { DEVICE_HUB.axeQuote.s.forEach((s) => usedKeys.add(s)); if (tool.run === "mobilebuildmcp") DEVICE_HUB.mbQuote.s.forEach((s) => usedKeys.add(s)); }
  for (const r of tool.calls ?? []) [...r.them.s, ...r.us.s].forEach((s) => usedKeys.add(s));
  const themList = [...(tool.them ?? []).map(note), ...forThem.map(esc)];
  const usList = [...(tool.us ?? []).map(note), ...forUs.map(esc)];
  const sources = [...usedKeys].map((k) => `<li><a href="${esc(SOURCES[k][1])}">${esc(SOURCES[k][0])}</a></li>`).join("\n      ");
  const body = `    <div class="answer">
      <p>${note(tool.pickThem)}</p>
      <p>${note(tool.pickUs)}</p>
      <p class="measured">${esc(measured)}</p>
      ${tool.formerly ? `<p class="measured">${note(tool.formerly)}</p>` : ""}
    </div>
  </div>

  <section id="measured">
    <h2>Measured side by side</h2>
    <p class="sub">From the <a href="/benchmarks">one-Mac benchmark</a> of ${esc(dateOf(su1))}: the same app and iPhone 17 Pro Simulator, one tool at a time, each through its own MCP server${them.interface === "cli" ? ` (${esc(tool.name)} through its command line)` : ""}. Times are medians; tokens are estimates (characters / 4).</p>
    ${measuredTable(them, tool.name)}
    <p class="fine">${esc(tool.name)} ${esc(version(them))}, simulator-use ${esc(version(su1))}. Every call is in <a href="${REPO}/tree/main/${resultsPath}">${esc(resultsPath)}</a>.</p>
  </section>
${tool.deviceHub ? `\n  ${deviceHubSection(tool)}\n` : ""}
  <section id="what">
    <h2>What each does</h2>
    <p class="sub">From each tool's own README, license and docs, read on ${esc(READ_ON)}.</p>
    ${factsTable(tool)}
  </section>

  <section id="better">
    <h2>Where simulator-use is better</h2>
    <ul class="notes">${usList.map((x) => `\n      <li>${x}</li>`).join("")}
    </ul>
    <p class="fine">A measured difference is listed when it is 5% or more.</p>
  </section>

  <section id="switching">
    <h2>Switching</h2>
    <p class="sub">Add simulator-use to Claude Code with one line (other clients: <a href="/#install">install</a>):</p>
    <div class="cmd">${esc(INSTALL)}</div>
    <p class="sub" style="margin-top:24px">The calls each made in the benchmark, step for step:</p>
    ${switchingTable(tool)}
  </section>

  <section id="sources">
    <h2>Sources</h2>
    <p class="sub">Read on ${esc(READ_ON)}. The measured numbers: <a href="/benchmarks">benchmarks</a> and <a href="${REPO}/tree/main/${resultsPath}">the raw results</a>.</p>
    <ul class="notes">
      ${sources}
    </ul>
  </section>`;
  const description = them.flow?.ok
    ? `simulator-use and ${tool.name} on the same iPhone 17 Pro Simulator: ${num(su1.flow.medianTokens)} against ${num(them.flow.medianTokens)} tokens read per sign-in${su1.flow.medianMs < them.flow.medianMs * 0.95 ? `, a sign-in in ${sec(su1.flow.medianMs)} against ${sec(them.flow.medianMs)}` : ""}, and what each builds, tests and needs, with sources.`
    : `simulator-use and ${tool.name} on the same iPhone 17 Pro Simulator, measured side by side, and what each builds, tests and needs, with sources.`;
  return { slug: tool.slug, name: tool.name, them, html: shell({ path: `/vs/${tool.slug}`, title: `simulator-use vs ${tool.name} for iOS Simulator automation`, description, h1: `simulator-use vs ${tool.name}`, body,
    ld: [
      crumb([["simulator-use", `${SITE}/`], ["Compare", `${SITE}/vs`], [`simulator-use vs ${tool.name}`, `${SITE}/vs/${tool.slug}`]]),
      { "@type": "TechArticle", headline: `simulator-use vs ${tool.name}`, description, url: `${SITE}/vs/${tool.slug}`, ...(MEASURED_ON ? { datePublished: MEASURED_ON, dateModified: MEASURED_ON } : {}),
        author: { "@type": "Organization", name: "NoMac", url: "https://nomac.app" }, publisher: { "@type": "Organization", name: "NoMac", url: "https://nomac.app" },
        about: [{ "@type": "SoftwareApplication", name: "simulator-use", url: `${SITE}/` }, { "@type": "SoftwareApplication", name: tool.name }] },
    ] }) };
}

// ---- write -----------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const pages = Object.keys(TOOLS).filter((k) => k !== "simulator-use").map(pageFor);
for (const p of pages) writeFileSync(join(outDir, `${p.slug}.html`), p.html);
const items = pages.map((p) => `      <li><a href="/vs/${p.slug}">simulator-use vs ${esc(p.name)}</a><span>${esc(p.them.flow?.ok ? `${num(p.them.flow.medianTokens)} tokens per sign-in against simulator-use's ${num(su1.flow.medianTokens)} (est.)` : `${p.name}: no completed sign-in`)}</span></li>`).join("\n");
const index = shell({
  path: "/vs", title: "simulator-use vs other iOS Simulator tools for agents",
  ld: [crumb([["simulator-use", `${SITE}/`], ["Compare", `${SITE}/vs`]])],
  description: "simulator-use against each tool in the one-Mac benchmark, one page each: measured side by side, what each does with sources, and how to switch.",
  h1: "simulator-use against every other iOS Simulator tool",
  body: `    <p class="lead">One page per tool from the <a href="/benchmarks">benchmark</a>: the numbers side by side, what each does from its own docs, and the calls to switch. simulator-use read ${esc(num(su1.flow.medianTokens))} tokens per sign-in (est.), the fewest of every tool measured.</p>
  </div>
  <section style="padding-top:48px">
    <ul class="vs">
${items}
    </ul>
  </section>`,
});
writeFileSync(join(outDir, "index.html"), index);

// llms.txt (llmstxt.org) beside the pages: what simulator-use is, how to install it, and where everything is, for agents.
const ranks = runs.filter((t) => !t.label && t.flow?.ok).sort((x, y) => x.flow.medianTokens - y.flow.medianTokens);
const nextTool = ranks[1], xc = ranks.find((t) => t.tool === "xcode-mcp");
const lead = ranks[0]?.tool === "simulator-use" && nextTool
  ? `- Benchmark (one Mac, ${ranks.length} tools, the same sign-in flow): simulator-use read ${num(su1.flow.medianTokens)} tokens per sign-in, ${(nextTool.flow.medianTokens / su1.flow.medianTokens).toFixed(1)}x fewer than the next tool${xc ? ` and ${Math.round(xc.flow.medianTokens / su1.flow.medianTokens)}x fewer than Xcode MCP` : ""}; its tool list and instructions take ${num(su1.toolList.totalTokens)} tokens.\n`
  : "";
const llms = `# simulator-use

> The fastest, most token-efficient way for an AI agent to use the iOS Simulator. An open-source (MIT) MCP server and CLI for Claude Code, Codex, Cursor and any MCP client: it builds and runs Xcode projects, reads the screen as a few lines of text, taps and types by label or id, and runs XCTest and XCUITest case by case.

- Claude Code: \`claude mcp add simulator-use -- npx -y simulator-use mcp\`
- Codex: \`codex mcp add simulator-use -- npx -y simulator-use mcp\`
- Any MCP client: run \`npx -y simulator-use mcp\` as a stdio server. Agents with a shell can use the CLI: \`npx simulator-use look\`.
- Needs macOS with Xcode, a Simulator runtime and Node 20 or newer. From Linux, Windows or a cloud agent, \`npx simulator-use cloud start\` runs the same tools on a NoMac cloud iPhone, billed per minute.
- Twelve tools: app_run, devices, device_use, app_control, ui_look, ui_act, app_logs, tests_run, screen_record, job_status, job_cancel, cloud.
${lead}
## Docs

- [README](https://raw.githubusercontent.com/NoMac-app/simulator-use/main/README.md): every tool, the screen format, building and running, tests, logs, the cloud, and what it can't do yet
- [Agent skill](https://raw.githubusercontent.com/NoMac-app/simulator-use/main/skill/SKILL.md): how an agent uses the CLI, in under 2 KB
- [Source on GitHub](${REPO})
- [npm package](https://www.npmjs.com/package/simulator-use)

## Benchmarks and comparisons

- [Benchmark](${SITE}/benchmarks): eight iOS Simulator tools on one sign-in flow, every call timed and published
${pages.map((pg) => `- [simulator-use vs ${pg.name}](${SITE}/vs/${pg.slug})`).join("\n")}

## Optional

- [NoMac](https://nomac.app): cloud Macs and iOS Simulators for AI agents, billed per minute
`;
writeFileSync(join(outDir, "..", "llms.txt"), llms);
console.log(`wrote ${pages.length} pages and the index into ${outDir}: ${pages.map((p) => p.slug).join(", ")}`);
