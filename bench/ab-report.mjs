#!/usr/bin/env node
// ab.sh's results: per build (A, B, and any more: C, D...), every step's median and p90 over all rounds, its checks,
// each round's medians (early against late), and the hard cases. Every build is compared with A.
//   node bench/ab-report.mjs OUT_DIR
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { median, p90 } from "./lib/measure.mjs";
const dir = process.argv[2];
const files = readdirSync(dir);
const runs = files.filter((f) => /^simulator-use\.[A-Z]\.r\d+\.json$/.test(f)).map((f) => ({ f, build: f.split(".")[1], round: Number(f.split(".")[2].slice(1)), data: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
const builds = [...new Set(runs.map((r) => r.build))].sort();
const steps = [["read", "read"], ["tap", "tap"], ["type", "fill"], ["flow", "sign-in, step by step"], ["flow-batch", "sign-in, batched"]];
const verify = {
  read: (o) => o.verify?.sawSignIn,
  tap: (o) => o.verify?.appSawTap && o.verify?.reportsChange,
  type: (o) => o.verify?.fieldShowsText,
  flow: (o) => o.verify?.sawWelcome && o.verify?.appSignedIn,
  "flow-batch": (o) => o.verify?.sawWelcome && o.verify?.appSignedIn,
};
const fmt = (ms) => (ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(2)} s`);
const others = builds.filter((b) => b !== "A");
console.log(`| Step | A median | A p90 | ${others.map((b) => `${b} median | ${b} p90 | ${b} vs A`).join(" | ")} | ${builds.map((b) => `${b} checks`).join(" | ")} |`);
console.log(`|---|---|---|${others.map(() => "---|---|---|").join("")}${builds.map(() => "---|").join("")}`);
for (const [op, name] of steps) {
  const cell = (build) => {
    const ops = runs.filter((r) => r.build === build).flatMap((r) => r.data.ops.filter((o) => o.op === op));
    const ok = ops.filter((o) => o.ok && verify[op](o));
    const ms = ok.map((o) => o.ms);
    return { med: median(ms), p90: p90(ms), checks: `${ok.length}/${ops.length}` };
  };
  const c = Object.fromEntries(builds.map((b) => [b, cell(b)]));
  const a = c.A ?? {};
  const vs = (x) => (a.med ? `${Math.round((x.med / a.med - 1) * 100)}%` : "-");
  console.log(`| ${name} | ${fmt(a.med)} | ${fmt(a.p90)} | ${others.map((b) => `${fmt(c[b].med)} | ${fmt(c[b].p90)} | ${vs(c[b])}`).join(" | ")} | ${builds.map((b) => c[b].checks).join(" | ")} |`);
}
console.log("\nPer round (median), in run order:");
console.log(["round", "build", "started", ...steps.map((s) => s[1])].join(" | "));
for (const r of runs.sort((x, y) => x.data.startedAt.localeCompare(y.data.startedAt))) {
  console.log([r.round, r.build, r.data.startedAt.slice(11, 19), ...steps.map(([op]) => fmt(median(r.data.ops.filter((o) => o.op === op && o.ok).map((o) => o.ms))))].join(" | "));
}
const hard = files.filter((f) => /^hard\.[A-Z]\.r\d+\.json$/.test(f)).map((f) => ({ build: f.split(".")[1], data: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
if (hard.length) {
  const hardBuilds = [...new Set(hard.map((h) => h.build))].sort();
  console.log("\nHard cases (ok/n, median of the timed call):");
  const names = [...new Set(hard.flatMap((h) => Object.keys(h.data.cases ?? {})))];
  console.log(`| Case | ${hardBuilds.join(" | ")} |`);
  console.log(`|---|${hardBuilds.map(() => "---|").join("")}`);
  for (const name of names) {
    const cell = (build) => {
      const rs = hard.filter((h) => h.build === build).flatMap((h) => h.data.cases?.[name] ?? []);
      const ms = rs.filter((r) => r.ok && r.timed).map((r) => r.timed);
      return `${rs.filter((r) => r.ok).length}/${rs.length}, ${fmt(median(ms))}`;
    };
    console.log(`| ${name} | ${hardBuilds.map(cell).join(" | ")} |`);
  }
}
