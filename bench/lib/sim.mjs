// The Simulator around the tools: boot it, reset the app, and watch the app's own log as a verifier that uses no
// accessibility (so it never competes with the tool under test for the Simulator's automation session).
import { execFileSync, spawn, spawnSync } from "node:child_process";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args, { timeout = 120_000, allowFail = false, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal}): ${(r.stderr || r.stdout || "").slice(-800)}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function state(udid) {
  const list = JSON.parse(sh("xcrun", ["simctl", "list", "devices", "-j"]).stdout);
  for (const [runtime, devices] of Object.entries(list.devices)) for (const d of devices) if (d.udid === udid) return { ...d, runtime };
  return null;
}

/** Shuts the Simulator down and boots it again, so no tool inherits another's automation session or helpers. */
export async function reboot(udid, settleMs = 20_000) {
  sh("xcrun", ["simctl", "shutdown", udid], { allowFail: true, timeout: 120_000 });
  sh("xcrun", ["simctl", "boot", udid], { timeout: 180_000 });
  sh("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 300_000 });
  await sleep(settleMs);
}

/** A fresh start of the app: terminate it and launch it again, then let its first frame settle. */
export async function resetApp(udid, bundleId, settleMs = 1500) {
  sh("xcrun", ["simctl", "terminate", udid, bundleId], { allowFail: true });
  sh("xcrun", ["simctl", "launch", udid, bundleId]);
  await sleep(settleMs);
}

/** The app's own log lines (subsystem dev.simtap.demo), streamed from the Simulator. */
export class AppLog {
  constructor(udid, subsystem) {
    this.lines = [];
    this.proc = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--level", "info", "--style", "compact", "--predicate", `subsystem == "${subsystem}"`], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { this.lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
  }
  mark() { return this.lines.length; }
  /** Waits up to timeoutMs for a line after `since` that matches re; answers the line or null. */
  async waitFor(re, since, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.lines.slice(since).find((l) => re.test(l));
      if (hit) return hit;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  }
  stop() { try { this.proc.kill("SIGTERM"); } catch {} }
}

/** The Mac, Xcode and the Simulator runtime, for the results file. */
export function environment(udid) {
  const out = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; } };
  const dev = state(udid);
  let runtime = null;
  try {
    const rts = JSON.parse(out("xcrun", ["simctl", "list", "runtimes", "-j"])).runtimes;
    runtime = rts.find((r) => r.identifier === dev?.runtime) ?? null;
  } catch {}
  return {
    date: new Date().toISOString(),
    macos: `${out("sw_vers", ["-productVersion"])} (${out("sw_vers", ["-buildVersion"])})`,
    hardware: { model: out("sysctl", ["-n", "hw.model"]), cpu: out("sysctl", ["-n", "machdep.cpu.brand_string"]), cores: Number(out("sysctl", ["-n", "hw.ncpu"])), memoryGB: Math.round(Number(out("sysctl", ["-n", "hw.memsize"])) / 2 ** 30) },
    xcode: out("xcodebuild", ["-version"])?.replace(/\n/g, ", "),
    node: process.version,
    simulator: { udid, name: dev?.name, deviceType: dev?.deviceTypeIdentifier, runtime: runtime ? `${runtime.name} (${runtime.buildversion})` : dev?.runtime },
  };
}

/** Kills processes whose command line matches one of the patterns, never this process or its parents. */
export function killMatching(patterns) {
  if (!patterns?.length) return [];
  const rows = sh("ps", ["-axo", "pid=,ppid=,command="]).stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const keep = new Set([process.pid]);
  for (let p = process.pid; parent.has(p) && p > 1; p = parent.get(p)) keep.add(parent.get(p));
  const killed = [];
  for (const r of rows) {
    // Never the harness, its parents, or the commands around it (ps itself, tee logging a run).
    if (keep.has(r.pid) || /^(ps|tee|bash|zsh|sh|grep) /.test(r.cmd) || r.cmd.includes("bench/run.mjs") || r.cmd.includes("run-all.sh")) continue;
    // SIGTERM first: a helper that holds the Simulator's automation session must get to close it (SIGKILL only after 3 s).
    if (patterns.some((p) => r.cmd.includes(p))) { try { process.kill(r.pid, "SIGTERM"); killed.push(r); } catch {} }
  }
  if (killed.length) {
    spawnSync("sleep", ["3"]);
    for (const r of killed) { try { process.kill(r.pid, 0); process.kill(r.pid, "SIGKILL"); } catch {} }
  }
  return killed.map((r) => `${r.pid} ${r.cmd.slice(0, 120)}`);
}
