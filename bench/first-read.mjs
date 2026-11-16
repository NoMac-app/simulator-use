#!/usr/bin/env node
// The first read after a phone boots, per engine build, interleaved: for each trial and each build (the order rotated
// every trial), the phone is shut down and booted (simctl boot, bootstatus -b), then the engine is started and asked
// to describe the screen until a read works, as NoMac's phone hosts do before they hand a phone over (hostd's pool
// boots it and calls simulator-use/readable, src/hosted.ts). --settle S waits S seconds after the boot and relaunches
// the demo first, as bench/run.mjs does before its warm-up read.
// Each trial's line in OUT/first-read.jsonl: the boot, the engine's ready line and how long it took, every read until
// the first that worked (ms, error, sessions), three reads after it, and the engine's session log for that run.
//   node bench/first-read.mjs --udid UDID --out DIR --trials 10 [--settle 20] A=/path/engine B=/path/engine[:reads] ...
// A build is LABEL=ENGINE_PATH, with :axe or :session after it to set SIMULATOR_USE_ENGINE_READS.
// node bench/first-read.mjs --report DIR prints the medians and spreads per build.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);

if (flag("report")) {
  const rows = readFileSync(join(flag("report"), "first-read.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const builds = [...new Set(rows.map((r) => r.build))];
  for (const b of builds) {
    const mine = rows.filter((r) => r.build === b);
    const first = mine.map((r) => r.firstOkMs).filter((x) => x != null);
    const ready = mine.map((r) => r.readyMs);
    const timeouts = mine.filter((r) => r.sessionLog.some((l) => /timed out|failed/.test(l))).length;
    console.log(`${b}: ${mine.length} trials, first read worked in ${first.length}; boot to first read: median ${median(first)} ms, p90 ${pct(first, 0.9)} ms, min ${Math.min(...first)}, max ${Math.max(...first)}; engine ready median ${median(ready)} ms (hid ${median(mine.map((r) => r.ready?.hid_ms ?? -1))} ms, transport ${[...new Set(mine.map((r) => r.ready?.hid))].join("/")}); trials with a session that timed out or failed: ${timeouts}`);
    console.log(`  each: ${mine.map((r) => (r.firstOkMs == null ? "FAIL" : (r.firstOkMs / 1000).toFixed(1))).join(", ")} s`);
  }
  process.exit(0);
}

const udid = flag("udid");
const out = flag("out");
const trials = Number(flag("trials", "10"));
const settle = Number(flag("settle", "0"));
const builds = argv.filter((a) => /^[A-Z][A-Za-z0-9]*=/.test(a)).map((a) => {
  const [label, rest] = a.split(/=(.*)/s);
  const m = rest.match(/^(.*?)(?::(axe|session))?$/);
  return { label, engine: m[1], reads: m[2] };
});
if (!udid || !out || builds.length < 1) {
  console.error("usage: node bench/first-read.mjs --udid UDID --out DIR --trials N [--settle S] A=ENGINE[:reads] B=ENGINE[:reads] ...");
  process.exit(2);
}
for (const b of builds) if (!existsSync(b.engine)) throw new Error(`no engine at ${b.engine}`);
mkdirSync(out, { recursive: true });
const sh = (cmd, args, timeout = 300_000) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const folder = process.env.TMPDIR || execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim() || tmpdir();
const sessionLogPath = join(folder.endsWith("/") ? folder : `${folder}/`, `simulator-use-engine-${udid}.log`);
const logLines = () => (existsSync(sessionLogPath) ? readFileSync(sessionLogPath, "utf8").split("\n").filter(Boolean) : []);

async function reboot() {
  const t0 = Date.now();
  sh("xcrun", ["simctl", "shutdown", udid]);
  const t1 = Date.now();
  sh("xcrun", ["simctl", "boot", udid]);
  sh("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  return { shutdownMs: t1 - t0, bootMs: Date.now() - t1 };
}

async function trial(build, n) {
  sh("pkill", ["-f", "simulator-use-engine"]);
  await sleep(1000);
  const boot = await reboot();
  if (settle > 0) {
    await sleep(settle * 1000);
    sh("xcrun", ["simctl", "terminate", udid, "dev.simtap.demo"]);
    sh("xcrun", ["simctl", "launch", udid, "dev.simtap.demo"]);
    await sleep(4500);
  }
  const loadavg = sh("sysctl", ["-n", "vm.loadavg"]).out.trim();
  const before = logLines().length;
  const env = { ...process.env };
  if (build.reads) env.SIMULATOR_USE_ENGINE_READS = build.reads;
  else delete env.SIMULATOR_USE_ENGINE_READS;
  const t0 = Date.now();
  const child = spawn(build.engine, ["--udid", udid], { stdio: ["pipe", "pipe", "ignore"], env });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (ms) => {
    let timer;
    try {
      const line = await Promise.race([lines.next(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))]);
      if (line.done) throw new Error("the engine stopped");
      return JSON.parse(line.value);
    } finally {
      clearTimeout(timer);
    }
  };
  let id = 0;
  const call = async (req) => {
    child.stdin.write(`${JSON.stringify({ id: ++id, ...req })}\n`);
    return next(120_000);
  };
  const row = { build: build.label, reads: build.reads ?? "default", trial: n, at: new Date().toISOString(), ...boot, settleS: settle, loadavg, ready: null, readyMs: null, attempts: [], firstOkMs: null, after: [], sessionLog: [] };
  try {
    row.ready = await next(60_000);
    row.readyMs = Date.now() - t0;
    if (row.ready.ready) {
      while (Date.now() - t0 < 240_000) {
        const a = await call({ op: "describe" });
        row.attempts.push({ ok: a.ok, ms: a.ms, error: a.error, sessions: a.sessions, bootstraps: a.bootstraps, bootstrap_error: a.bootstrap_error, session_wait_ms: a.session_wait_ms, session_recoveries: a.session_recoveries });
        if (a.ok) {
          row.firstOkMs = Date.now() - t0;
          break;
        }
        await sleep(300);
      }
      if (row.firstOkMs != null) for (let i = 0; i < 3; i++) row.after.push((await call({ op: "describe" })).ms);
    }
  } catch (error) {
    row.error = String(error.message ?? error);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([new Promise((r) => child.once("exit", () => r(true))), sleep(5000).then(() => false)]);
    if (!exited) child.kill("SIGKILL");
  }
  row.sessionLog = logLines().slice(before);
  appendFileSync(join(out, "first-read.jsonl"), `${JSON.stringify(row)}\n`);
  const firstS = row.firstOkMs == null ? "FAIL" : `${(row.firstOkMs / 1000).toFixed(1)} s`;
  console.log(`${new Date().toISOString().slice(11, 19)} trial ${n} ${build.label}: boot ${(boot.bootMs / 1000).toFixed(1)} s, ready ${row.readyMs} ms (hid ${row.ready?.hid_ms} ms ${row.ready?.hid ?? ""}), first read ${firstS} after ${row.attempts.length} tries, then ${row.after.join("/")} ms | ${row.sessionLog.map((l) => l.replace(/^\S+ pid \d+ /, "")).join("; ")}${row.error ? ` ERROR ${row.error}` : ""}`);
}

for (let n = 1; n <= trials; n++) {
  for (let k = 0; k < builds.length; k++) await trial(builds[(n - 1 + k) % builds.length], n);
}
sh("pkill", ["-f", "simulator-use-engine"]);
console.log("done");
