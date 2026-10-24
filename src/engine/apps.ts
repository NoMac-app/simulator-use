import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "../errors.ts";
import { isOurs, run } from "./exec.ts";
import { deviceDir, deviceEnv, deviceTimeZone } from "./state.ts";

const simctl = (args: string[], timeoutMs = 60_000) => run("xcrun", ["simctl", ...args], { timeoutMs });

/** The value of a key in `simctl appinfo`'s old-style plist output. */
export function plistValue(text: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key} = "?([^";\\n]+)"?;`).exec(text);
  return match?.[1]?.trim();
}

export async function appInfo(udid: string, bundleId: string): Promise<{ executable?: string; name?: string } | undefined> {
  try {
    const { stdout } = await simctl(["appinfo", udid, bundleId], 15_000);
    if (!stdout.includes("CFBundleIdentifier")) return undefined;
    // simctl escapes non-ASCII names (Café as Caf\U00e9): the app's own Info.plist has them as written.
    const path = plistValue(stdout, "Path");
    const fromPlist = async (key: string) =>
      path ? (await run("plutil", ["-extract", key, "raw", join(path, "Info.plist")], { timeoutMs: 10_000 }).catch(() => undefined))?.stdout.trim() || undefined : undefined;
    const name = (await fromPlist("CFBundleDisplayName")) ?? (await fromPlist("CFBundleName")) ?? plistValue(stdout, "CFBundleDisplayName") ?? plistValue(stdout, "CFBundleName");
    return { executable: (await fromPlist("CFBundleExecutable")) ?? plistValue(stdout, "CFBundleExecutable"), name };
  } catch {
    return undefined;
  }
}

/** A bundle id as Apple allows it, so it can name files safely. */
export const BUNDLE_ID = /^[A-Za-z0-9.-]+$/;

/** Reads the bundle id from a built .app, so `install` can name what it installed. */
export async function bundleIdOf(appPath: string): Promise<string> {
  const plist = join(appPath, "Info.plist");
  if (!existsSync(plist)) throw new ToolError(`${appPath} is not an .app bundle (no Info.plist).`, "Pass the path to a Simulator build, such as build/Build/Products/Debug-iphonesimulator/MyApp.app.");
  const { stdout } = await run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist], { timeoutMs: 10_000 });
  return stdout.trim();
}

export async function install(udid: string, appPath: string): Promise<void> {
  try {
    await simctl(["install", udid, appPath], 120_000);
  } catch (error) {
    throw new ToolError(`Could not install ${appPath}: ${(error as Error).message}`, "Check it is built for the Simulator (iphonesimulator), not a device.");
  }
}

/** The file a launched app's print() output goes to, kept while the app runs. */
export async function consoleFile(udid: string, bundleId: string): Promise<string> {
  return join(await deviceDir(udid), `${bundleId}.console.log`);
}

/**
 * A new, empty file at path, open for writing. The previous launch's launcher can still write to the old file at
 * its own offset: truncating that file left NUL bytes before the next line (October 23). So the old file goes and a
 * new one is made; the old writer keeps writing into a file no one reads.
 */
export function freshFile(path: string): number {
  try {
    unlinkSync(path);
  } catch {
    // None yet.
  }
  return openSync(path, "w");
}

/**
 * Launches fresh (any running copy is stopped) and keeps the app's print() output for app_logs.
 * simctl's --stdout wrote nothing on iOS 26.5, so a detached `simctl launch --console-pty` holds the app's
 * output instead, writing to a file until the app ends; NSUnbufferedIO is what Xcode sets so lines arrive at once.
 */
/** A launched app: with --console-pty its launcher lives as long as the app, so ended() says the app is gone. */
export type Launched = { ended: () => boolean };

export async function launch(udid: string, bundleId: string): Promise<Launched> {
  const file = await consoleFile(udid, bundleId);
  const timeZone = await deviceTimeZone(udid);
  const env = Object.fromEntries(Object.entries(await deviceEnv(udid)).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]));
  const fd = freshFile(file);
  const child = spawn("xcrun", ["simctl", "launch", "--console-pty", "--terminate-running-process", udid, bundleId], {
    detached: true,
    stdio: ["ignore", fd, fd],
    // The time zone app_control set (iOS takes a process's TZ) and app_run's env: simctl hands SIMCTL_CHILD_ variables to the app.
    env: { ...process.env, ...env, SIMCTL_CHILD_NSUnbufferedIO: "YES", ...(timeZone ? { SIMCTL_CHILD_TZ: timeZone } : {}) },
  });
  closeSync(fd);
  let ended = false;
  child.once("exit", () => (ended = true));
  // A launch that fails ends the launcher within moments; a running app keeps it alive.
  const code = await new Promise<number | null | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 2_000);
    child.once("exit", (c) => (clearTimeout(timer), resolve(c)));
    child.once("error", () => (clearTimeout(timer), resolve(-1)));
  });
  child.unref();
  if (code !== undefined && code !== 0) {
    const output = readFileSync(file, "utf8").trim();
    if (/not installed|FBSOpenApplicationServiceErrorDomain|Unable to find|could not be found/i.test(output)) {
      throw new ToolError(`${bundleId} is not installed on this Simulator.`, 'Install it first: app_control {action: "install", app: "path/to/App.app"}.');
    }
    throw new ToolError(`Could not launch ${bundleId}: ${output.split("\n").slice(-3).join(" ")}`);
  }
  return { ended: () => ended };
}

/** The app's own system log lines, streamed to a file while simulator-use watches it. */
export async function streamFile(udid: string, bundleId: string): Promise<string> {
  return join(await deviceDir(udid), `${bundleId}.syslog.log`);
}

/**
 * The system log predicate for what an app itself logged: its own sender or subsystem. Apple's frameworks
 * also log faults from inside the app (on iOS 27, a keyboard queue timeout on every first focus); a grep
 * reaches those, and a crash is in the crash report and the print output.
 */
export function ownLines(executable: string, bundleId: string): string {
  const name = executable.replace(/"/g, "");
  return `process == "${name}" AND (sender == "${name}" OR subsystem BEGINSWITH "${bundleId.replace(/"/g, "")}")`;
}

/**
 * Streams the app's own log lines to a file from before it launches. \`log show\` is not enough: macOS keeps
 * info lines only in memory, and the Simulator's UIKit noise pushed the sample app's "signed in" line out
 * within 30 s (October 19). One stream per app and device; a new launch replaces the old stream.
 */
export async function startLogStream(udid: string, bundleId: string, executable: string): Promise<void> {
  await stopLogStream(udid, bundleId);
  const file = await streamFile(udid, bundleId);
  const fd = openSync(file, "w");
  const child = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "info", "--predicate", ownLines(executable, bundleId)], {
    detached: true,
    stdio: ["ignore", fd, "ignore"],
  });
  closeSync(fd);
  child.unref();
  if (child.pid) writeFileSync(`${file}.pid`, String(child.pid));
  // The stream needs a moment to attach before the app's first lines.
  await new Promise((r) => setTimeout(r, 300));
}

export async function stopLogStream(udid: string, bundleId: string): Promise<void> {
  const pidFile = `${await streamFile(udid, bundleId)}.pid`;
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  if (await isOurs(pid, /simctl spawn .* log stream/)) {
    try {
      process.kill(pid);
    } catch {
      // Gone between the check and the signal.
    }
  }
  rmSync(pidFile, { force: true });
}

export async function simctlAction(args: string[], what: string, timeoutMs = 30_000): Promise<string> {
  try {
    return (await simctl(args, timeoutMs)).stdout.trim();
  } catch (error) {
    throw new ToolError(`Could not ${what}: ${(error as Error).message}`);
  }
}

export async function pushPayload(udid: string, bundleId: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("xcrun", ["simctl", "push", udid, bundleId, "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new ToolError(`Could not send the push: ${stderr.trim()}`))));
    child.stdin.end(payload);
  });
}

/** Puts text on the Simulator's clipboard, for pasting what the keyboard can't type (é, 日本, emoji). */
export async function setPasteboard(udid: string, text: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("xcrun", ["simctl", "pbcopy", udid], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code, signal) => (code === 0 ? resolve() : reject(new ToolError(`Could not set the Simulator's clipboard: ${stderr.trim() || signal || `exit ${code}`}`))));
      child.stdin.end(text);
    });
  } catch (error) {
    // A macOS user with no screen session (a shared Simulator host's users) has no pasteboard server, and simctl
    // pbcopy crashes: the helper sets the phone's own pasteboard from inside the phone instead.
    const helper = pasteHelper();
    if (!helper) throw error;
    try {
      await simctl(["spawn", udid, helper, text], 15_000);
    } catch (fallback) {
      throw new ToolError(`Could not set the Simulator's clipboard: ${(error as Error).message}; from inside the phone: ${(fallback as Error).message}`);
    }
  }
}

/** native/pbset, built for the Simulator, beside the engine in vendor/axe; undefined when it is not there. */
export function pasteHelper(): string | undefined {
  const bundled = fileURLToPath(new URL("../../vendor/axe/simulator-use-pbset", import.meta.url));
  return existsSync(bundled) ? bundled : undefined;
}
