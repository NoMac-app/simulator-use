// Per-call medians of each step, per build, over every round: which call of a flow got slower or faster.
//   node breakdown.mjs OUT_DIR
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const runs = readdirSync(dir).filter((f) => /^simulator-use\.[A-Z]\.r\d+\.json$/.test(f)).map((f) => ({ build: f.split(".")[1], data: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const builds = [...new Set(runs.map((r) => r.build))].sort();
for (const op of ["read", "tap", "type", "flow", "flow-batch", "warmup"]) {
  console.log(`\n${op}: per call (median ms)`);
  for (const b of builds) {
    const ops = runs.filter((r) => r.build === b).flatMap((r) => r.data.ops.filter((o) => o.op === op && o.ok));
    const width = Math.max(0, ...ops.map((o) => o.calls?.length ?? 0));
    const cols = [];
    for (let i = 0; i < width; i++) {
      const calls = ops.map((o) => o.calls?.[i]).filter(Boolean);
      const label = calls[0] ? `${calls[0].tool}${calls[0].args?.steps ? `(${calls[0].args.steps.join(";").slice(0, 22)})` : ""}` : "?";
      cols.push(`${label} ${Math.round(med(calls.map((c) => c.ms)))}`);
    }
    console.log(`  ${b} (n=${ops.length}, total ${Math.round(med(ops.map((o) => o.ms)))}): ${cols.join(" | ")}`);
  }
}
