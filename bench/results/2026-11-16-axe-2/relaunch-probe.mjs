// The first read after an app relaunch, at the engine: relaunch the demo, wait 1.5 s (as bench/run.mjs does), one
// lean describe with reuse (as ui_look asks), then a second read. Each read's total, its serializes, reloads, sessions.
//   node relaunch-probe.mjs ENGINE UDID [N] [engine args...]
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, n = "6", ...extra] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, ...extra], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
let id = 0;
const call = async (req) => { child.stdin.write(JSON.stringify({ id: ++id, ...req }) + "\n"); return next(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (...a) => { try { execFileSync("xcrun", ["simctl", ...a], { stdio: "ignore" }); } catch {} };
const ready = await next();
console.log(`ready reads=${ready.reads} hid=${ready.hid}`);
const w = await call({ op: "describe", lean: true });
console.log(`warm ${w.ms} ms serialize=${JSON.stringify(w.serialize_ms)} bootstraps=${w.bootstraps} sessions=${w.sessions}`);
for (let i = 0; i < Number(n); i++) {
  simctl("terminate", udid, "dev.simtap.demo"); simctl("launch", udid, "dev.simtap.demo");
  await sleep(1500);
  const a = await call({ op: "describe", lean: true, reuse: true, max_age_ms: 30000 });
  const b = await call({ op: "describe", lean: true, reuse: true, max_age_ms: 30000 });
  const count = (t) => JSON.stringify(t ?? []).split('"type"').length - 1;
  console.log(`relaunch ${i}: first ${a.ms} ms serialize=${JSON.stringify(a.serialize_ms)} nodes=${count(a.tree)} kept=${a.kept ?? a.reused} bootstraps=${a.bootstraps} sessions=${a.sessions}${a.session_wait_ms ? ` wait=${a.session_wait_ms}` : ""} | second ${b.ms} ms ${b.reused ? `reused(${b.reused})` : `serialize=${JSON.stringify(b.serialize_ms)}`}`);
}
child.stdin.end(); setTimeout(() => process.exit(0), 3000);
