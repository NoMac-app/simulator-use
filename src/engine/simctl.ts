import { existsSync } from "node:fs";
import { join } from "node:path";

import { cloudFirst, withCloudHint } from "../cloud-hint.ts";
import { ToolError } from "../errors.ts";
import { run } from "./exec.ts";
import { withLock } from "./lock.ts";

export type Device = {
  udid: string;
  name: string;
  state: string;
  /** For example "iOS 26.5". */
  runtime: string;
  booted: boolean;
};

const NO_SIMULATOR = "This computer can't run the iOS Simulator: it needs macOS with Xcode and a Simulator runtime.";

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" becomes "iOS 26.5". */
export function runtimeName(identifier: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)(?:-(\d+))?$/.exec(identifier);
  if (!match) return identifier;
  const [, os, major, minor, patch] = match;
  return `${os === "xrOS" ? "visionOS" : os} ${major}.${minor}${patch ? `.${patch}` : ""}`;
}

type SimctlDevice = { udid: string; name: string; state: string; isAvailable?: boolean };

/** Parses `simctl list devices --json`: available devices only, booted first, then by runtime and name. */
export function parseDevices(json: string): Device[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, SimctlDevice[]> };
  const devices: Device[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue;
      devices.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeName(runtime), booted: d.state === "Booted" });
    }
  }
  // iOS before watchOS, tvOS and visionOS (by name, "watchOS 26" would sort first); the newest iOS first;
  // iPhones before iPads: most agents want a phone.
  const platform = (d: Device) => (d.runtime.startsWith("iOS ") ? 0 : 1);
  const version = (d: Device) => d.runtime.replace(/^\S+\s/, "");
  const family = (d: Device) => ["iPhone", "iPad"].findIndex((p) => d.name.startsWith(p)) >>> 0;
  return devices.sort(
    (a, b) =>
      Number(b.booted) - Number(a.booted) ||
      platform(a) - platform(b) ||
      version(b).localeCompare(version(a), undefined, { numeric: true }) ||
      family(a) - family(b) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/** The MCP server lives for a whole session: one list serves the calls of the next few seconds (0.35 s saved each). */
const CACHE_MS = 5_000;
let cached: { at: number; devices: Device[] } | undefined;

/** The developer folder Xcode was found in (DEVELOPER_DIR, or none for xcode-select's): it does not go away. */
let xcodeFound: string | undefined;

/**
 * Why this machine can't run the iOS Simulator at all, or nothing: not a Mac, or a Mac without Xcode (none, or only
 * the Command Line Tools, which have no simctl). Checked before any tool that needs the Simulator, so the agent
 * reads that and its way on, never a build tool's error. xcode-select -p never asks a person to install anything.
 */
export async function simulatorMissing(): Promise<ToolError | undefined> {
  if (process.platform !== "darwin") return new ToolError("This machine can't run the iOS Simulator: it needs a Mac with Xcode.", cloudFirst("Run simulator-use on a Mac with Xcode."));
  const asked = process.env.DEVELOPER_DIR ?? "";
  if (xcodeFound === asked) return undefined;
  const developer = asked || (await run("xcode-select", ["-p"], { timeoutMs: 10_000 }).then((r) => r.stdout.trim(), () => ""));
  if (developer && existsSync(join(developer, "usr", "bin", "simctl"))) {
    xcodeFound = asked;
    return undefined;
  }
  return new ToolError("This Mac has no Xcode, so it can't run the iOS Simulator (the Command Line Tools alone have none).", cloudFirst("Install Xcode from the App Store and open it once."));
}

export async function listDevices(fresh = false): Promise<Device[]> {
  const missing = process.platform !== "darwin" ? await simulatorMissing() : undefined;
  if (missing) throw missing;
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.devices;
  try {
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
    cached = { at: Date.now(), devices: parseDevices(stdout) };
    return cached.devices;
  } catch (error) {
    throw listError(error as Error);
  }
}

/**
 * Why simctl gave no device list. A timeout means the Simulator service is still starting (it can take a minute
 * the first time after a reboot or an Xcode update), not that this computer can't run it.
 */
export function listError(error: Error): ToolError {
  if (/timed out after/.test(error.message)) {
    return new ToolError("The Simulator service did not answer within 30 s: it can take a minute to start the first time after a reboot or an Xcode update.", "Call again in 30 s.");
  }
  return new ToolError(`${NO_SIMULATOR} (${error.message})`, withCloudHint("Install Xcode from the App Store, open it once, then add an iOS Simulator runtime in Settings > Components."));
}

export async function xcodeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run("xcodebuild", ["-version"], { timeoutMs: 15_000 });
    return stdout.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

/** A device by name or UDID; a name on several runtimes means the booted one, else the newest. */
export function findDevice(devices: Device[], wanted: string): Device | undefined {
  const want = wanted.trim().toLowerCase();
  // "iPhone 17 Pro (iOS 26.5)", the way simulator-use prints a device, picks that runtime's phone; a bare name
  // means the newest runtime's.
  const withRuntime = /^(.+?)\s*\((.+)\)$/.exec(want);
  const matches = devices.filter(
    (d) =>
      d.udid.toLowerCase() === want ||
      d.name.toLowerCase() === want ||
      (withRuntime !== null && d.name.toLowerCase() === withRuntime[1] && d.runtime.toLowerCase() === withRuntime[2]),
  );
  return matches.find((d) => d.booted) ?? matches[0];
}

/**
 * The device a call works on: the one named (by name or UDID), else the one this agent holds (device_use),
 * else the only booted one.
 */
export function pickDevice(devices: Device[], wanted?: string, held?: string): Device {
  const booted = devices.filter((d) => d.booted);
  if (wanted) {
    const device = findDevice(devices, wanted);
    if (!device) throw new ToolError(`No Simulator named "${wanted}".`, "Call devices to see the names and UDIDs on this Mac.");
    if (!device.booted) throw new ToolError(`${device.name} (${device.runtime}) is not booted.`, `Call device_use {device: "${device.udid}"} to boot it.`);
    return device;
  }
  const mine = held && booted.find((d) => d.udid === held);
  if (mine) return mine;
  // The device this agent chose was shut down (by another agent's boot, say): never slide onto someone else's.
  const gone = held && devices.find((d) => d.udid === held);
  if (gone) throw new ToolError(`${gone.name} (${gone.runtime}), the Simulator this agent was using, is no longer booted.`, `Call device_use {device: "${gone.udid}"} to boot it again, or device_use another.`);
  if (booted.length === 1) return booted[0]!;
  if (!booted.length) {
    const suggestion = devices.find((d) => d.name.startsWith("iPhone")) ?? devices[0];
    throw new ToolError("No Simulator is booted.", suggestion ? `Call device_use {device: "${suggestion.name}"} to boot ${suggestion.name} (${suggestion.runtime}).` : "Call devices to see what this Mac has.");
  }
  throw new ToolError(`${booted.length} Simulators are booted: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}.`, "Call device_use with the one to use, or pass device.");
}

/** A call may take 45 s: waiting for another boot and this boot share 40 of them. */
const BOOT_BUDGET_MS = 40_000;
const LOCK_WAIT_MS = 20_000;

/**
 * One boot at a time on this Mac, across every simulator-use process (each agent runs its own), held in a lock
 * (lock.ts) that a dead owner's successor takes over.
 */
const withBootLock = <T>(work: () => Promise<T>): Promise<T> =>
  withLock("boot", LOCK_WAIT_MS, () => new ToolError("Another Simulator is still booting, and boots never overlap.", "Call device_use again in 30 s."), work);

export type Boot = { ms: number; ready: boolean; waitedMs: number; shutDown: string[] };

/**
 * Boots a device and waits until it is ready, within the time a call may take. Two Simulators booting at once
 * on an 8 GB Mac pushed it into swap for minutes (measured October 18), so boots never overlap. With a limit on
 * booted devices (SIMULATOR_USE_MAX_BOOTED), others are shut down first, inside the lock so two calls can't both
 * see room.
 */
export async function bootDevice(device: Device, maxBooted = Infinity): Promise<Boot> {
  const asked = Date.now();
  return withBootLock(async () => {
    const started = Date.now();
    // A boot started outside simulator-use (Xcode, simctl) is waited out too.
    while (Date.now() - asked < LOCK_WAIT_MS && (await listDevices(true)).some((d) => d.state === "Booting" && d.udid !== device.udid)) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const others = (await listDevices(true)).filter((d) => d.booted && d.udid !== device.udid);
    const shutDown: string[] = [];
    for (const d of others.slice(0, Math.max(0, others.length - (maxBooted - 1)))) {
      await shutdownDevice(d);
      shutDown.push(d.name);
    }
    try {
      await run("xcrun", ["simctl", "boot", device.udid], { timeoutMs: 20_000 });
    } catch (error) {
      if (!/current state: Booted/i.test((error as Error).message)) throw new ToolError(`Could not boot ${device.name}: ${(error as Error).message}`);
    }
    let ready = true;
    try {
      await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeoutMs: Math.max(5_000, BOOT_BUDGET_MS - (Date.now() - asked)) });
    } catch {
      ready = false;
    }
    cached = undefined;
    return { ms: Date.now() - started, ready, waitedMs: started - asked, shutDown };
  });
}

export async function shutdownDevice(device: Device): Promise<void> {
  await run("xcrun", ["simctl", "shutdown", device.udid], { timeoutMs: 15_000 }).catch(() => undefined);
  cached = undefined;
}
