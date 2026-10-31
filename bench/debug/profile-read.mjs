#!/usr/bin/env node
// What a whole-screen read costs, with FBSimulatorControl's own profile: elements, attribute fetches, XPC calls.
//   node bench/debug/profile-read.mjs ENGINE_PATH UDID
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [enginePath, udid] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const child = spawn(enginePath, ["--udid", udid], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
const call = async (req) => { const s = now(); child.stdin.write(JSON.stringify(req) + "\n"); const l = (await lines.next()).value; return { a: JSON.parse(l), rtt: now() - s, bytes: l.length }; };
try { execFileSync("xcrun", ["simctl", "terminate", udid, "dev.simtap.demo"], { stdio: "ignore" }); } catch {}
execFileSync("xcrun", ["simctl", "launch", udid, "dev.simtap.demo"], { stdio: "ignore" });
await sleep(2500);
await call({ op: "describe" });
const MIN = ["label", "frameDict", "value", "uniqueID", "type", "role", "roleDescription", "subrole", "enabled", "pid"];
const run = async (title) => {
  for (const [name, keys] of [["default", undefined], ["min", MIN], ["min-nopid", MIN.filter((k) => k !== "pid")]]) {
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const r = await call({ op: "describe", profile: true, ...(keys ? { keys } : {}) });
      rows.push({ ms: r.a.ms, bytes: r.bytes, ...(r.a.profile ?? {}) });
    }
    const med = (k) => { const s = rows.map((r) => r[k]).filter((x) => x !== undefined).sort((a, b) => a - b); return s.length ? +Number(s[Math.floor(s.length / 2)]).toFixed(3) : undefined; };
    console.log(title, name, JSON.stringify(Object.fromEntries(Object.keys(rows[0]).map((k) => [k, med(k)]))));
  }
};
await run("no keyboard");
await call({ op: "steps", steps: [{ tap: [201, 194] }] });
await sleep(1500);
await run("keyboard up");
child.stdin.end();
await sleep(1500);
process.exit(0);
