#!/usr/bin/env node
// The first read after an app starts: how long it takes and where (each accessibility read, the reload, the waits).
//   node bench/debug/launch-read.mjs ENGINE_PATH UDID [rounds]
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [enginePath, udid, rounds = "6"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(enginePath, ["--udid", udid], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
const call = async (req) => { const t = Date.now(); child.stdin.write(JSON.stringify(req) + "\n"); const a = JSON.parse((await lines.next()).value); a.rtt = Date.now() - t; return a; };
const count = (n) => [n].flat().reduce((s, x) => s + 1 + (x.children ? count(x.children) : 0), 0);
await call({ op: "describe" });
for (let i = 0; i < Number(rounds); i++) {
  try { execFileSync("xcrun", ["simctl", "terminate", udid, "dev.simtap.demo"], { stdio: "ignore" }); } catch {}
  execFileSync("xcrun", ["simctl", "launch", udid, "dev.simtap.demo"], { stdio: "ignore" });
  await sleep(1500);
  const a = await call({ op: "describe" });
  const b = await call({ op: "describe" });
  console.log(`launch ${i}: first read ${a.rtt} ms (serialize ${JSON.stringify(a.serialize_ms)}, bootstraps ${a.bootstraps}, ${count(a.tree)} nodes); next read ${b.rtt} ms (${count(b.tree)} nodes)`);
}
child.stdin.end();
await sleep(1500);
process.exit(0);
