import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { askHost, hostOffers } from "../host.ts";
import { ownLines } from "./apps.ts";
import { run } from "./exec.ts";
import { stateDir } from "./state.ts";

/** A line from the system log, shortened: `01:52:54.047 error login: sign-in rejected`. */
export type LogLine = { time: string; level: string; text: string };

const LEVELS: Record<string, string> = { Df: "", I: "info", Db: "debug", E: "error", F: "fault" };
/** `2026-10-19 01:56:22.114 E  Demo[94957:88904] (Sender) [subsystem:category] message`; sender and subsystem are optional. */
const COMPACT = /^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d\.\d+) (\w+)\s+\S+?\[\d+:\w+\] (?:\(([^)]+)\) )?(?:\[([^\]]+)\] )?(.*)$/;

/** Parses `log show --style compact`. Activity lines (type A) are bookkeeping, never kept. */
export function parseSystemLog(output: string, appSubsystem?: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of output.split("\n")) {
    const m = COMPACT.exec(raw);
    if (!m || m[2] === "A") continue;
    const [, time, type, sender, source = "", text = ""] = m;
    const [subsystem = "", category = ""] = source.split(":");
    const tag = subsystem && appSubsystem && subsystem.startsWith(appSubsystem) ? category : source || (sender ? `(${sender})` : "");
    lines.push({ time: time!, level: LEVELS[type!] ?? type!, text: `${tag ? `${tag}: ` : ""}${text}` });
  }
  return lines;
}

/**
 * The app's lines from the Simulator's system log. Apple's frameworks log a great deal from inside the app's
 * process (UIKit's event dispatch, several lines a tap; on the Simulator, a haptics error every key press), so
 * by default only what the app itself logged is read, and faults from anywhere; `everything` reads it all.
 */
export async function systemLog(udid: string, executable: string, seconds: number, bundleId: string, everything = false): Promise<LogLine[]> {
  const predicate = everything ? `process == "${executable.replace(/"/g, "")}"` : ownLines(executable, bundleId);
  const { stdout } = await run("xcrun", ["simctl", "spawn", udid, "log", "show", "--style", "compact", "--info", "--last", `${Math.max(1, Math.ceil(seconds))}s`, "--predicate", predicate], {
    timeoutMs: 12_000,
  });
  return parseSystemLog(stdout, bundleId);
}

/** Lines from the app's own log stream (startLogStream) that are newer than `since` (ms since 1970). */
export async function streamedLines(file: string, since: number, bundleId: string): Promise<LogLine[] | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    // The stamp is the Mac's local time, as `2026-10-19 02:04:48.818`.
    const stamp = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)/.exec(raw);
    if (!stamp || new Date(`${stamp[1]}T${stamp[2]}`).getTime() < since) continue;
    lines.push(...parseSystemLog(raw, bundleId));
  }
  return lines;
}

/** The app's print() output, without the Simulator's own start-up noise. */
export function cleanConsole(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim() && !/^objc\[\d+\]: Class .* is implemented in both/.test(line));
}

export type Crash = { file: string; time: string; summary: string[] };

/** Where macOS writes a user's crash reports. */
export const homeReports = () => join(homedir(), "Library", "Logs", "DiagnosticReports");

/**
 * Crash reports of a Simulator app land on the Mac itself, in ~/Library/Logs/DiagnosticReports, named after
 * the app's executable, and macOS moves each, whole and with its time, into its Retired folder (within seconds on some
 * Macs), so both are read. An .ips file is one JSON header line, then the report as JSON. Another app with the same
 * executable name, or the same app on another Simulator, writes reports there too: a report is this app's when its
 * header's bundleID is the app's, and this device's when its process path (or coalition) names the device. dir: the
 * folders to read instead, each with its Retired (hostCrashReports' and the home's on NoMac's phone host).
 */
export async function crashReports(executable: string, since: number, of: { bundleId?: string; udid?: string; dir?: string | string[] } = {}, limit = 3): Promise<Crash[]> {
  const dirs = (of.dir === undefined ? [homeReports()] : [of.dir].flat()).flatMap((dir) => [dir, join(dir, "Retired")]);
  const files: { file: string; at: number }[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.startsWith(`${executable}-`) && n.endsWith(".ips"));
    } catch {
      continue;
    }
    files.push(...(await Promise.all(names.map(async (n) => ({ file: join(dir, n), at: await stat(join(dir, n)).then((s) => s.mtimeMs, () => 0) })))));
  }
  // A report macOS was moving while this read could be in both folders: once.
  const seen = new Set<string>();
  const recent = files
    .filter((f) => f.at >= since)
    .sort((a, b) => b.at - a.at)
    .filter((f) => (seen.has(basename(f.file)) ? false : (seen.add(basename(f.file)), true)));
  const out: Crash[] = [];
  for (const f of recent) {
    if (out.length >= limit) break;
    const text = await readFile(f.file, "utf8");
    if (!reportOf(text, of.bundleId, of.udid)) continue;
    // When it crashed, not when macOS finished writing the report (up to a minute later).
    const time = /"captureTime"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? new Date(f.at).toISOString();
    out.push({ file: f.file, time, summary: summarizeIps(text, executable) });
  }
  return out;
}

/** What NoMac Simulator's host answers for the phone's crash reports (src/host.ts). */
export const HOST_CRASH_REPORTS = "nomac/crash_reports";

/**
 * On NoMac Simulator's host a phone's crash reports are not in its user's home: that user has no login session, so
 * macOS writes them to the system's folder, which it cannot read. The host hands over the reports of the user's own
 * phone apps since the user's last wipe (nomac-sim crash-reports): they go to a folder of simulator-use's own, read as
 * the home's is. Undefined where the host offers none (a developer's Mac).
 */
export async function hostCrashReports(): Promise<string | undefined> {
  if (!hostOffers(HOST_CRASH_REPORTS)) return undefined;
  const answer = (await askHost(HOST_CRASH_REPORTS, {}, 25_000)) as { reports?: unknown } | null;
  const dir = join(stateDir(), "crash-reports");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reports = Array.isArray(answer?.reports) ? answer.reports.slice(0, 20) : [];
  for (const report of reports as { name?: unknown; text?: unknown; modified_ms?: unknown }[]) {
    const { name, text, modified_ms: at } = report ?? {};
    // macOS's own names (<process>-<date>.ips): never a path, never hidden.
    if (typeof name !== "string" || !/^[^./\\\0][^/\\\0]{0,250}\.ips$/.test(name) || typeof text !== "string") continue;
    const file = join(dir, name);
    await writeFile(file, text, { mode: 0o600 });
    // When macOS wrote it, which the since of app_logs compares.
    if (typeof at === "number" && Number.isFinite(at) && at > 0) await utimes(file, at / 1000, at / 1000).catch(() => undefined);
  }
  return dir;
}

/** Whether a report is this app's on this device; a report without the field to tell is kept. */
function reportOf(text: string, bundleId?: string, udid?: string): boolean {
  const newline = text.indexOf("\n");
  let header: { bundleID?: unknown } = {};
  let body: { procPath?: unknown; coalitionName?: unknown } = {};
  try {
    header = JSON.parse(text.slice(0, newline < 0 ? undefined : newline)) as typeof header;
    body = JSON.parse(text.slice(newline + 1)) as typeof body;
  } catch {
    // An unreadable part tells nothing.
  }
  if (bundleId && typeof header.bundleID === "string" && header.bundleID !== bundleId) return false;
  const where = [body.procPath, body.coalitionName].filter((v): v is string => typeof v === "string");
  if (udid && where.length && !where.some((w) => w.includes(`/Devices/${udid}/`) || w.endsWith(`.${udid}`))) return false;
  return true;
}

type Frame = { imageIndex?: number; symbol?: string; imageOffset?: number; sourceFile?: string; sourceLine?: number };
type Ips = {
  exception?: { type?: string; signal?: string; codes?: string };
  termination?: { indicator?: string; reasons?: string[] };
  asi?: Record<string, string[]>;
  faultingThread?: number;
  threads?: { frames?: Frame[]; triggered?: boolean }[];
  usedImages?: { name?: string }[];
};

/**
 * What went wrong and where: the exception, the reason, and the crashing thread from the top down to just past
 * the app's own last frame (the rest is the framework that called it).
 */
export function summarizeIps(text: string, executable?: string): string[] {
  const body = text.slice(text.indexOf("\n") + 1);
  let ips: Ips;
  try {
    ips = JSON.parse(body) as Ips;
  } catch {
    return ["(unreadable crash report)"];
  }
  const out: string[] = [];
  if (ips.exception) out.push(`exception: ${[ips.exception.type, ips.exception.signal].filter(Boolean).join(" ")}`);
  const reasons = [...(ips.termination?.reasons ?? []), ...Object.values(ips.asi ?? {}).flat(), ips.termination?.indicator ?? ""].filter(Boolean);
  for (const reason of reasons.slice(0, 3)) out.push(`reason: ${reason.replace(/\s+/g, " ").trim()}`);
  const thread = ips.threads?.find((t) => t.triggered) ?? ips.threads?.[ips.faultingThread ?? 0];
  const all = thread?.frames ?? [];
  const imageOf = (f: Frame) => ips.usedImages?.[f.imageIndex ?? -1]?.name ?? "?";
  const own = (f: Frame) => Boolean(executable) && (imageOf(f) === executable || imageOf(f).startsWith(`${executable}.`));
  const lastOwn = all.reduce((last, f, i) => (own(f) ? i : last), -1);
  const frames = all.slice(0, lastOwn >= 0 ? Math.min(lastOwn + 3, 12) : 8).map((f) => {
    const image = imageOf(f);
    const where = f.sourceFile ? ` (${f.sourceFile}:${f.sourceLine ?? "?"})` : "";
    return `  ${image} ${f.symbol ?? `+${f.imageOffset ?? 0}`}${where}`;
  });
  if (frames.length) out.push("crashed thread:", ...frames);
  return out;
}
