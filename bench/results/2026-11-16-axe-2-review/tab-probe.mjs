// Whether taps land: on the demo, tap the Items tab and read the screen (Item 1 shown?), then the Login tab (Sign In
// shown?), 3 times; each tap's time and way (via).   node tab-probe.mjs ENGINE UDID [engine args...]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, ...extra] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, ...extra], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
let id = 0;
const call = async (req) => { child.stdin.write(`${JSON.stringify({ id: ++id, ...req })}\n`); return next(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => JSON.stringify(t);
const ready = await next();
const out = { ready: { hid: ready.hid, hid_choice: ready.hid_choice, hid_keys: ready.hid_keys, dtuhidd: ready.dtuhidd, error: ready.error }, taps: [] };
if (ready.ready) {
  for (let i = 0; i < 3; i++) {
    for (const [x, y, want] of [[244, 822, "Item 1"], [158, 822, "Sign In"]]) {
      const a = await call({ op: "tap", x, y });
      await sleep(900);
      const seen = text((await call({ op: "describe", lean: true })).tree).includes(want);
      out.taps.push({ ms: a.ms, via: a.via, ok: a.ok, error: a.error, landed: seen });
    }
  }
}
out.landed = `${out.taps.filter((t) => t.landed).length} of ${out.taps.length}`;
console.log(JSON.stringify(out));
child.stdin.end();
setTimeout(() => process.exit(0), 2500);
