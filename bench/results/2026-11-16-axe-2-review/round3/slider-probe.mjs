// How EdgeLab's slider (#volume) answers drags from its thumb: to where a value's thumb would be (thumb radius 14 pt,
// as ui-act.ts assumes), and by a few points. For each: the value before and after. Absolute tracking lands on the
// same value from any start; tracking relative to the touch, less a slop, lands short by the slop.
//   node slider-probe.mjs ENGINE UDID
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
let id = 0;
const call = async (req) => { child.stdin.write(JSON.stringify({ id: ++id, ...req }) + "\n"); return JSON.parse((await lines.next()).value); };
const find = (xs) => { for (const e of xs ?? []) { if (JSON.stringify(e).includes('"volume"') && /slider/i.test(e.type ?? e.role ?? "")) return e; const c = find(e.children); if (c) return c; } };
const slider = async () => find((await call({ op: "describe" })).tree);
const R = 14;
let e = await slider();
const f = e.frame;
const val = (e) => { const v = Number(String(e.AXValue ?? e.value).replace("%", "")); return v > 1 ? v / 100 : v; };
console.log("slider frame", JSON.stringify(f), "value", val(e));
const at = (v) => f.x + R + v * (f.width - 2 * R);
const y = Math.round(f.y + f.height / 2);
const pt = (f.width - 2 * R) / 100;
for (const [label, target] of [["to 10%", 0.1], ["to 75%", 0.75], ["to 40%", 0.4], ["to 75% again", 0.75], ["+9 pt", 9], ["+15 pt", 15], ["+25 pt", 25], ["-25 pt", -25]]) {
  const v0 = val(await slider());
  const x0 = at(v0);
  const x1 = typeof target === "number" && Math.abs(target) >= 1 ? x0 + target : at(target);
  await call({ op: "drag", x1: Math.round(x0), y1: y, x2: Math.round(x1), y2: y, duration: 0.6 });
  await new Promise((r) => setTimeout(r, 500));
  const v1 = val(await slider());
  const want = (x1 - f.x - R) / (f.width - 2 * R);
  console.log(`${label}: ${(v0 * 100).toFixed(1)} -> ${(v1 * 100).toFixed(1)}, the finger ended at ${(want * 100).toFixed(1)} (moved ${((x1 - x0) / pt).toFixed(1)} points, landed ${((v1 - want) * 100).toFixed(1)} from the finger)`);
}
child.stdin.end();
