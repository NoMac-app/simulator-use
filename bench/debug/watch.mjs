#!/usr/bin/env node
// Where and when the screen changes after an input: the engine's watch op (each change's box, in points).
//   node bench/debug/watch.mjs ENGINE_PATH UDID
// The demo app (dev.simtap.demo) must be installed; nothing else may hold an engine on the phone.
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [enginePath, udid] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(enginePath, ["--udid", udid], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
const call = async (req) => { child.stdin.write(JSON.stringify(req) + "\n"); return JSON.parse((await lines.next()).value); };
const reset = async () => {
  try { execFileSync("xcrun", ["simctl", "terminate", udid, "dev.simtap.demo"], { stdio: "ignore" }); } catch {}
  execFileSync("xcrun", ["simctl", "launch", udid, "dev.simtap.demo"], { stdio: "ignore" });
  await sleep(2500);
  await call({ op: "describe" });
};
/** Changes grouped into runs: consecutive changes less than 60 ms apart, with the union of their boxes. */
const runs = (changes) => {
  const out = [];
  for (const c of changes) {
    const [t, x, y, w, h] = c;
    const last = out.at(-1);
    if (last && t - last.end < 60) {
      last.end = t; last.n++;
      if (x !== undefined && x >= 0) last.box = last.box ? [Math.min(last.box[0], x), Math.min(last.box[1], y), Math.max(last.box[2], x + w), Math.max(last.box[3], y + h)] : [x, y, x + w, y + h];
    } else out.push({ start: t, end: t, n: 1, box: x !== undefined && x >= 0 ? [x, y, x + w, y + h] : null });
  }
  return out.map((r) => `${r.start}-${r.end} ms (${r.n}) ${r.box ? `x ${r.box[0]}-${r.box[2]}, y ${r.box[1]}-${r.box[3]}` : "no pixel change"}`);
};
const show = (title, a) => { console.log(`== ${title} (diff ${a.diff_ms_avg?.toFixed?.(2)} ms each)`); for (const r of runs(a.changes ?? [])) console.log("  ", r); if (a.error) console.log("  error", a.error); };

await reset();
show("tap Sign In", await call({ op: "watch", tap: [201, 350], window_ms: 1500 }));
await reset();
show("tap the Email field", await call({ op: "watch", tap: [201, 194], window_ms: 2500 }));
show("idle, Email focused", await call({ op: "watch", window_ms: 3000 }));
await call({ op: "steps", steps: [{ type: "gary@example.com" }] });
show("after typing", await call({ op: "watch", window_ms: 3000 }));
show("idle after typing", await call({ op: "watch", window_ms: 3000 }));
show("tap the Password field", await call({ op: "watch", tap: [201, 246], window_ms: 2000 }));
await call({ op: "steps", steps: [{ type: "secret1" }] });
show("tap Sign In with Password focused", await call({ op: "watch", tap: [201, 350], window_ms: 2500 }));
await reset();
show("tap the Items tab", await call({ op: "watch", tap: [244, 822], window_ms: 1500 }));
const items = await call({ op: "describe" });
let item;
const walk = (n) => { for (const x of [n].flat()) { if (x.AXLabel === "Item 1" && x.frame) item = item ?? x; walk(x.children ?? []); } };
walk(items.tree);
const at = item ? [item.frame.x + item.frame.width / 2, item.frame.y + item.frame.height / 2] : [201, 200];
show(`tap Item 1 at ${at.map(Math.round)} (push)`, await call({ op: "watch", tap: at, window_ms: 1500 }));
const d = await call({ op: "describe" });
console.log("after the push, nodes:", JSON.stringify(d.tree).length, "bytes");
child.stdin.end();
await sleep(1500);
process.exit(0);
