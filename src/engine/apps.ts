import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import { isOurs, run } from "./exec.ts";
import { laterVersion } from "./xcode.ts";
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

/** Installs a .app; runtime ("iOS 27.0", the Simulator's) lets a refusal say when the app needs a later iOS. */
export async function install(udid: string, appPath: string, runtime?: string): Promise<void> {
  try {
    await simctl(["install", udid, appPath], 120_000);
  } catch (error) {
    const phone = runtime && /^iOS (\d+(?:\.\d+)*)$/.exec(runtime)?.[1];
    const needs = phone ? (await run("plutil", ["-extract", "MinimumOSVersion", "raw", join(appPath, "Info.plist")], { timeoutMs: 10_000 }).catch(() => undefined))?.stdout.trim() : undefined;
    if (phone && needs && laterVersion(needs, phone)) {
      throw new ToolError(`Could not install ${appPath}: it needs iOS ${needs} (its deployment target) and this Simulator runs ${runtime}.`, `Build it with a deployment target of iOS ${phone} or earlier (IPHONEOS_DEPLOYMENT_TARGET), then install it again.`);
    }
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

/**
 * The app's launch arguments from one string, split into words as a shell would: quotes keep spaces in a word, a
 * backslash keeps the next character (in double quotes, a $, `, " or \\), nothing is expanded. `-Key value` sets that key in UserDefaults for this launch.
 * They reach the app through simctl's arguments, which every user of a Mac can read (ps), so never a secret: app_run's
 * env is the private way in (a process's environment is its own user's).
 */
export function launchWords(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    // A shell's word separators only: a no-break space (French copy) stays in its word.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'" || c === '"') {
      const end = c === "'" ? text.indexOf("'", i + 1) : closingQuote(text, i + 1);
      if (end < 0) throw new ToolError(`The launch arguments have a ${c === "'" ? "single" : "double"} quote that is never closed.`, `Quote a word with spaces whole: -Greeting "Hello there".`);
      const inner = text.slice(i + 1, end);
      word = (word ?? "") + (c === "'" ? inner : inner.replace(/\\([$`"\\])/g, "$1"));
      i = end;
    } else if (c === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i];
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  if (words.length > 100) throw new ToolError("A launch takes up to 100 arguments.");
  if (words.some((w) => w.includes("\0"))) throw new ToolError("A launch argument can't hold a NUL character.");
  return words;
}

/** Where a double-quoted word ends: the next " not escaped by a backslash. */
function closingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** A word a shell (and launchWords) reads back as it is: in single quotes when it needs them. */
export const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

export async function launch(udid: string, bundleId: string, args: string[] = [], executable?: string): Promise<Launched> {
  const file = await consoleFile(udid, bundleId);
  const before = executable ? await appPids(udid, executable) : [];
  const timeZone = await deviceTimeZone(udid);
  const env = Object.fromEntries(Object.entries(await deviceEnv(udid)).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]));
  const fd = freshFile(file);
  const child = spawn("xcrun", ["simctl", "launch", "--console-pty", "--terminate-running-process", udid, bundleId, ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    // The time zone app_control set (iOS takes a process's TZ) and app_run's env: simctl hands SIMCTL_CHILD_ variables to the app.
    env: { ...process.env, ...env, SIMCTL_CHILD_NSUnbufferedIO: "YES", ...(timeZone ? { SIMCTL_CHILD_TZ: timeZone } : {}), ...webOpenEnv(env) },
  });
  closeSync(fd);
  let ended = false;
  child.once("exit", () => (ended = true));
  // A launch that fails ends the launcher within moments; a running app keeps it alive. So the launch is known to
  // have worked once the app's own process is there, one that was not before the launch (the app's last run is
  // ended by the launch, and may still be going as it starts): that is looked for every 40 ms, not waited out for a
  // fixed 2 s as before (which every launch paid: 3.1 to 4.2 s a launch, November 22, 2026). Without the app's
  // executable name, or with no process seen in 2 s, the launcher still running after 2 s says it, as before.
  const code = await new Promise<number | null | undefined>((resolve) => {
    let over = false;
    const done = (c: number | null | undefined) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      resolve(c);
    };
    const timer = setTimeout(() => done(undefined), 2_000);
    child.once("exit", (c) => done(c));
    child.once("error", () => done(-1));
    if (executable) {
      void (async () => {
        while (!over) {
          const now = await appPids(udid, executable);
          if (now.some((pid) => !before.includes(pid))) return done(undefined);
          await new Promise((r) => setTimeout(r, 40));
        }
      })();
    }
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

const KEYBOARD_KEYS = ["KeyboardAutocorrection", "KeyboardPrediction", "KeyboardCheckSpelling", "KeyboardShowPredictionBar", "SmartQuotesEnabled", "SmartDashesEnabled"];
const KEYBOARD_DOMAINS = ["com.apple.Preferences", "com.apple.keyboard.preferences"];
const KEYBOARD_CHANGED = ["AppleKeyboardsSettingsChangedNotification", "com.apple.keyboard.preferences.changed", "AppleKeyboardsPreferencesChangedNotification"];
const plainKeyboards = new Map<string, Promise<void>>();

/**
 * The Simulator's keyboard without autocorrection, predictions, spell check and smart punctuation, so text typed
 * into a field is the text asked for. With them, iOS changed about one typed text in three as it went ("teh quick
 * --udid web" became "teh quick —used web"), which a fill then had to see, clear and paste again: 3.2 to 3.8 s a
 * fill where 0.7 s does it (November 22, 2026). Looked at once per Simulator and process, set only where it is not
 * yet (the settings stay with the Simulator), and told to the keyboard at once (it takes them without a restart).
 * SIMULATOR_USE_KEYBOARD=ios leaves iOS's own behaviour, for an agent that tests it.
 */
export function plainKeyboard(udid: string): Promise<void> {
  if (setting("KEYBOARD") === "ios") return Promise.resolve();
  let done = plainKeyboards.get(udid);
  if (!done) {
    done = (async () => {
      const read = await simctl(["spawn", udid, "defaults", "read", KEYBOARD_DOMAINS[0]!, KEYBOARD_KEYS[0]!], 5_000).then((r) => r.stdout.trim(), () => "");
      if (read === "0") return;
      await Promise.all(KEYBOARD_DOMAINS.flatMap((domain) => KEYBOARD_KEYS.map((key) => simctl(["spawn", udid, "defaults", "write", domain, key, "-bool", "NO"], 5_000).catch(() => undefined))));
      await Promise.all(KEYBOARD_CHANGED.map((name) => simctl(["spawn", udid, "notifyutil", "-p", name], 5_000).catch(() => undefined)));
    })().catch(() => undefined);
    plainKeyboards.set(udid, done);
  }
  return done;
}

/**
 * The library that lets the app's web views be inspected (native/webopen), loaded into the app as it starts, after
 * any library the app's own environment asks for. Left out with SIMULATOR_USE_WEB=off, or when it is not in this
 * install.
 */
export function webOpenEnv(env: Record<string, string>): Record<string, string> {
  if (setting("WEB") === "off") return {};
  const library = setting("WEBOPEN") ?? fileURLToPath(new URL("../../vendor/axe/simulator-use-webopen.dylib", import.meta.url));
  if (!existsSync(library)) return {};
  const asked = env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES ?? process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
  return { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: asked ? `${asked}:${library}` : library };
}

/**
 * The processes of an app on a Simulator: this user's, run from that Simulator's own folder (another user's phone on
 * the same Mac has the same UDID on a NoMac host, and may run an app of the same name).
 */
export async function appPids(udid: string, executable: string): Promise<number[]> {
  const name = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const { stdout } = await run("pgrep", ["-u", String(process.getuid?.() ?? 0), "-f", `/Devices/${udid}/.*/${name}\\.app/${name}( |$)`], { timeoutMs: 3_000 });
    return stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
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
  const file = await streamFile(udid, bundleId);
  // The stream of an earlier launch of this app is kept: it follows the app by name, so a new launch's lines come on
  // it with nothing missed, and without the moment a new stream needs to attach (0.3 s a launch). Its lines are read
  // by their time (streamedLines), so what is older than this launch is not this launch's. A stream grown past 16 MB
  // is started over.
  if (await streamAlive(file, executable)) return;
  await stopLogStream(udid, bundleId);
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

const STREAM_MAX_BYTES = 16 * 1024 * 1024;

/** Whether the app's log stream is still running, for this executable, and its file within its size. */
async function streamAlive(file: string, executable: string): Promise<boolean> {
  const pidFile = `${file}.pid`;
  if (!existsSync(pidFile) || !existsSync(file)) return false;
  try {
    if (statSync(file).size > STREAM_MAX_BYTES) return false;
  } catch {
    return false;
  }
  const name = executable.replace(/"/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return isOurs(Number(readFileSync(pidFile, "utf8")), new RegExp(`simctl spawn .* log stream .*process == "${name}"`));
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

/**
 * A push to an app. iOS refuses one (UNErrorDomain 2003) to an app that is not installed, or has no notification
 * permission: it never asked for it, or the person said no. Measured on iOS 27.2 (November 18, 2026): an app that asked
 * and was allowed gets it shown; one that was refused still gets it through its notification delegate while it is in
 * front, though iOS shows nothing. The refusal says which of these it is, and what to do.
 */
export async function sendPush(udid: string, bundleId: string, payload: string): Promise<void> {
  try {
    await pushPayload(udid, bundleId, payload);
  } catch (error) {
    if (!(error instanceof ToolError) || !/domain=UNErrorDomain, code=2003\b/.test(error.message)) throw error;
    const installed = await simctl(["get_app_container", udid, bundleId], 15_000).then(() => true, () => false);
    if (!installed) throw new ToolError(`${bundleId} is not installed on this Simulator, so iOS refused the push.`, "Install it first (app_run builds and installs it), then push again.");
    throw new ToolError(
      `iOS refused the push: ${bundleId} has no notification permission (it never asked for it, or it was refused). iOS shows nothing; an app in front may still get it through its notification delegate.`,
      'Make the app ask (UNUserNotificationCenter requestAuthorization) and allow it: app_run answers iOS\'s prompt unless permissions is "ask". Then push again.',
    );
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

/** Runs xcrun with the text on its input: what is typed never goes in an argument, which every user of a Mac can read. */
export function withInput(args: string[], input: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("xcrun", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code, signal) => (clearTimeout(timer), code === 0 ? resolve() : reject(new ToolError(stderr.trim() || (signal ? `ended by ${signal}` : `exit ${code}`)))));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Puts text on the Simulator's clipboard, for pasting what the keyboard can't type (é, 日本, emoji). */
export async function setPasteboard(udid: string, text: string): Promise<void> {
  let failure: string;
  try {
    await withInput(["simctl", "pbcopy", udid], text, 15_000);
    // While Device Hub shows the phone, it keeps the phone's clipboard in step with the Mac's, and what simctl pbcopy
    // puts there never arrives: the phone's clipboard read back empty and the paste left the field as it was, with any
    // build of simulator-use (November 16, 2026). So it is read back, and set from inside the phone when it differs.
    // simctl pbpaste prints the clipboard's bytes as they are (no newline added), so the text must come back exactly.
    const back = await simctl(["pbpaste", udid], 15_000).then((r) => r.stdout, () => undefined);
    if (back === text) return;
    // Not read back at all: pbcopy is trusted, as before, unless the phone's own helper can make sure.
    if (back === undefined && !pasteHelper()) return;
    failure = back === undefined ? "simctl pbpaste failed" : "simctl pbcopy's text did not reach the phone (Device Hub keeps its clipboard in step with the Mac's)";
  } catch (error) {
    // A macOS user with no screen session (a shared Simulator host's users) has no pasteboard server, and simctl
    // pbcopy crashes: the helper sets the phone's own pasteboard from inside the phone instead, from its input.
    failure = (error as Error).message;
  }
  const helper = pasteHelper();
  if (!helper) throw new ToolError(`Could not set the Simulator's clipboard: ${failure}`);
  try {
    await withInput(["simctl", "spawn", udid, helper, "-"], text, 15_000);
  } catch (fallback) {
    throw new ToolError(`Could not set the Simulator's clipboard: ${failure}; from inside the phone: ${(fallback as Error).message}`);
  }
}

/** native/pbset, built for the Simulator, beside the engine in vendor/axe; undefined when it is not there. */
export function pasteHelper(): string | undefined {
  const bundled = fileURLToPath(new URL("../../vendor/axe/simulator-use-pbset", import.meta.url));
  return existsSync(bundled) ? bundled : undefined;
}
