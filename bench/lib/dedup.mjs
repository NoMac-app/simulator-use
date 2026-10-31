#!/usr/bin/env node
// Stores each long answer text of a results file once: a call whose text (or opened file) is longer than 1,000
// characters keeps `textRef` / `fileRef`, an index into the file's `texts`. A JSON text equal to a stored one up to
// the order of its keys (AXe prints its keys in a new order on every call; the length is the same) shares that entry
// and is marked `reordered`. summarize.mjs reads both forms. Idempotent:
//   node bench/lib/dedup.mjs bench/results/2026-10-31/*.json
import { readFileSync, writeFileSync } from "node:fs";

export function hydrate(run) {
  const T = run.texts ?? [];
  const fix = (c) => { if (c.textRef !== undefined && c.text === undefined) c.text = T[c.textRef]; if (c.fileRef !== undefined && c.fileText === undefined) c.fileText = T[c.fileRef]; };
  for (const op of run.ops ?? []) for (const o of [op, op.prep, op.post]) for (const c of o?.calls ?? []) fix(c);
  return run;
}

function dedup(run) {
  hydrate(run);
  const texts = [], index = new Map();
  const canon = (s) => { try { return JSON.stringify(JSON.parse(s), (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v)) + `#${s.length}`; } catch { return s; } };
  const ref = (s) => { const k = canon(s); if (!index.has(k)) { index.set(k, texts.length); texts.push(s); } const i = index.get(k); return { i, reordered: texts[i] !== s }; };
  for (const op of run.ops ?? []) for (const o of [op, op.prep, op.post]) for (const c of o?.calls ?? []) {
    if (typeof c.text === "string" && c.text.length > 1000) { const r = ref(c.text); c.textRef = r.i; if (r.reordered) c.reordered = true; delete c.text; }
    if (typeof c.fileText === "string" && c.fileText.length > 1000) { const r = ref(c.fileText); c.fileRef = r.i; delete c.fileText; }
  }
  run.texts = texts;
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2).filter((f) => f.endsWith(".json") && !f.endsWith(".tools.json") && !f.includes("summary"))) {
    const before = readFileSync(f, "utf8").length;
    const out = JSON.stringify(dedup(JSON.parse(readFileSync(f, "utf8"))), null, 1);
    writeFileSync(f, out);
    console.log(`${f}: ${before} -> ${out.length} chars`);
  }
}
