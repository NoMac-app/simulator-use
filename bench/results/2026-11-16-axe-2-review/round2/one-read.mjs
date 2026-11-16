// One engine, one read: start the engine, describe the screen once, close it. Prints the time and the session log
// lines of this engine.   node one-read.mjs ENGINE UDID LABEL
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const [engine, udid, label] = process.argv.slice(2);
const folder = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
const log = `${folder}simulator-use-engine-${udid}.log`;
const before = existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0;
const t0 = Date.now();
const child = spawn(engine, ["--udid", udid], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
child.stdin.write(JSON.stringify({ id: 1, op: "describe" }) + "\n");
const a = JSON.parse((await lines.next()).value);
const ms = Date.now() - t0;
child.stdin.end();
await new Promise((r) => { child.once("exit", r); setTimeout(r, 8000); });
const mine = readFileSync(log, "utf8").split("\n").slice(before).filter(Boolean).map((l) => l.replace(/^\S+ pid \d+ /, ""));
console.log(`${label}: read ${a.ok ? "ok" : "FAILED " + a.error} in ${(ms / 1000).toFixed(1)} s | ${mine.join("; ")}`);
