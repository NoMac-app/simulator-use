// Session-free reads of a phone over time: one engine with --no-bootstrap (no automation session, AXe 2.0's
// bootstrap: false), a describe every INTERVAL ms for SECONDS, one line each: seconds since start, ms, and what came
// back (error, empty app, or the number of elements and the frontmost pid).
//   node ax-probe.mjs ENGINE UDID SECONDS [INTERVAL_MS] [LABEL]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, seconds, interval = "1000", label = "probe"] = process.argv.slice(2);
const t0 = Date.now();
const child = spawn(engine, ["--udid", udid, "--no-bootstrap"], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const ready = JSON.parse((await lines.next()).value);
console.log(`${label} ready in ${Date.now() - t0} ms reads=${ready.reads ?? "?"}`);
const count = (x) => (Array.isArray(x) ? x.reduce((n, e) => n + 1 + count(e?.children), 0) : 0);
let id = 0;
while (Date.now() - t0 < Number(seconds) * 1000) {
  const start = Date.now();
  child.stdin.write(JSON.stringify({ id: ++id, op: "describe", keys: ["label", "type", "pid", "frame"] }) + "\n");
  const a = JSON.parse((await lines.next()).value);
  const at = ((start - t0) / 1000).toFixed(1);
  const tree = a.tree ?? a.elements ?? a.result;
  const what = !a.ok ? `ERROR ${String(a.error).slice(0, 90)}` : `${count(tree)} elements, pid ${tree?.[0]?.pid ?? "?"}, first "${tree?.[0]?.label ?? tree?.[0]?.type ?? ""}"`;
  console.log(`${label} t=${at}s ${Date.now() - start} ms ${what} stable=${a.stable ?? "?"} sessions=${a.sessions ?? "?"}`);
  const wait = Number(interval) - (Date.now() - start);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
child.stdin.end();
await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
