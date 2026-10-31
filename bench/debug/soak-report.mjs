#!/usr/bin/env node
// soak.mjs's output as medians per step in 5-minute bins: does any step get slower over the session?
//   node bench/debug/soak-report.mjs soak.jsonl [binMinutes]
import { readFileSync } from "node:fs";
const [file, binArg = "5"] = process.argv.slice(2);
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bin = Number(binArg) * 60;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)] / 2 + s[Math.ceil((s.length - 1) / 2)] / 2) : null; };
const steps = ["read", "fill-email", "fill-password", "tap", "final-read", "still-read"];
const bins = new Map();
for (const r of rows) {
  if (r.round === undefined || r.round < 0 || r.ms === undefined) continue;
  const b = Math.floor(r.t / bin);
  if (!bins.has(b)) bins.set(b, Object.fromEntries(steps.map((s) => [s, []])));
  bins.get(b)[r.step]?.push(r.ms);
}
console.log(["minutes", ...steps, "rounds"].join("\t"));
for (const [b, v] of [...bins].sort((x, y) => x[0] - y[0])) console.log([`${b * Number(binArg)}-${(b + 1) * Number(binArg)}`, ...steps.map((s) => med(v[s])), v.read.length].join("\t"));
const checks = rows.filter((r) => r.step === "check");
const errors = rows.filter((r) => r.error);
console.log(`rounds checked ${checks.length}, failed ${checks.filter((c) => !c.ok).length}, calls with an error ${errors.length}`);
