// A finger held on EdgeLab's slider through the engine: down on the thumb and moved toward 75 (up: false), the slider
// read at its middle (op point) while held, moved again by the shortfall (down: false, up: false), read, then lifted.
//   node hold-probe.mjs ENGINE UDID [TARGET]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, target = "75"] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
let id = 0;
const call = async (req) => { child.stdin.write(JSON.stringify({ id: ++id, ...req }) + "\n"); return JSON.parse((await lines.next()).value); };
const find = (xs) => { for (const e of xs ?? []) { if (JSON.stringify(e).includes('"volume"') && /slider/i.test(e.type ?? e.role ?? "")) return e; const c = find(e.children); if (c) return c; } };
const pct = (v) => { const n = Number(String(v).replace("%", "")); return n > 1 ? n : n * 100; };
const e = find((await call({ op: "describe" })).tree);
const f = e.frame, R = 14, track = f.width - 2 * R, y = Math.round(f.y + f.height / 2), mid = Math.round(f.x + f.width / 2);
const at = (p) => Math.round(f.x + R + (p / 100) * track);
const read = async () => { const a = await call({ op: "point", x: mid, y }); const el = Array.isArray(a.element) ? a.element[0] : a.element; return { v: el?.AXValue, type: el?.type ?? el?.role, ok: a.ok, err: a.error }; };
let v = pct(e.AXValue ?? e.value), x = at(v);
console.log(`start ${v.toFixed(1)} frame ${JSON.stringify(f)}; point read: ${JSON.stringify(await read())}`);
let next = at(Number(target));
let a = await call({ op: "drag", x1: x, y1: y, x2: next, y2: y, duration: 0.4, steps: Math.ceil(Math.abs(next - x) / 4), up: false });
console.log(`move 1 (down, held) ${x}->${next}: ok=${a.ok} ${a.error ?? ""}; read held: ${JSON.stringify(await read())}`);
x = next;
for (let i = 2; i <= 4; i++) {
  const r = await read(); const now = pct(r.v);
  next = Math.round(x + ((Number(target) - now) / 100) * track);
  a = await call({ op: "drag", x1: x, y1: y, x2: next, y2: y, duration: 0.4, steps: Math.max(1, Math.ceil(Math.abs(next - x) / 4)), down: false, up: false });
  console.log(`move ${i} (held) ${x}->${next} for ${now.toFixed(1)}: ok=${a.ok}; read held: ${JSON.stringify(await read())}`);
  x = next;
}
a = await call({ op: "drag", x1: x, y1: y, x2: x, y2: y, duration: 0.1, steps: 1, down: false });
await new Promise((r) => setTimeout(r, 500));
console.log(`lifted: ok=${a.ok}; read: ${JSON.stringify(await read())}; describe: ${pct(find((await call({ op: "describe" })).tree)?.AXValue).toFixed(1)}`);
child.stdin.end();
