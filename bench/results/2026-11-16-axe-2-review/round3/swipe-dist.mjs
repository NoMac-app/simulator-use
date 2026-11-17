// How far a left swipe across an EdgeLab list row may go before iOS takes it as a full swipe (the row's first action,
// Delete, done at once) rather than showing the row's actions. Each try: a fresh row, a 0.3 s swipe (the engine's,
// as `swipe left "Row N"` sends) centred on the row and covering FRACTION of its width; then what the screen shows.
//   node swipe-dist.mjs ENGINE UDID
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
let id = 0;
const call = async (req) => { child.stdin.write(JSON.stringify({ id: ++id, ...req }) + "\n"); return JSON.parse((await lines.next()).value); };
const flat = (xs, out = []) => { for (const e of xs ?? []) { out.push(e); flat(e.children, out); } return out; };
const screen = async () => flat((await call({ op: "describe" })).tree);
const label = (e) => e.AXLabel ?? e.label ?? "";
let row = 4;
for (const fraction of [0.3, 0.4, 0.5, 0.6, 0.7, 0.4, 0.5, 0.6]) {
  let els = await screen();
  const r = els.find((e) => label(e) === `Row ${row}`);
  if (!r) { console.log(`Row ${row} not on screen`); break; }
  const f = r.frame, y = Math.round(f.y + f.height / 2);
  const x1 = Math.round(f.x + f.width * (0.5 + fraction / 2)), x2 = Math.round(f.x + f.width * (0.5 - fraction / 2));
  await call({ op: "swipe", x1, y1: y, x2, y2: y, duration: 0.3 });
  await new Promise((res) => setTimeout(res, 1200));
  els = await screen();
  const gone = !els.some((e) => label(e) === `Row ${row}`), shown = els.some((e) => label(e) === "Delete");
  console.log(`row width ${Math.round(f.width)} pt, swipe ${Math.round(fraction * 100)}% (${x1 - x2} pt): ${gone ? "DELETED (full swipe)" : shown ? "actions shown" : "nothing"}`);
  if (shown) { const h = els.find((e) => label(e) === "Rows"); if (h) await call({ op: "tap", x: Math.round(h.frame.x + 10), y: Math.round(h.frame.y + h.frame.height / 2) }); await new Promise((res) => setTimeout(res, 800)); }
  row++;
}
child.stdin.end();
