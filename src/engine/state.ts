import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setting } from "../settings.ts";

/**
 * What a call can leave for the next one.
 * - The device an MCP server's agent holds lives in its memory: each agent runs its own server, so two agents
 *   never share it. A CLI call is its own process, so the CLI keeps the device in a file (persistHeld), and
 *   `simulator-use use` carries over to the next command.
 * - The app last launched on a device is a small file next to its log files, so the CLI and MCP see the same.
 */
let held: string | undefined;
let persist = false;

/** Where simulator-use keeps its files: SIMULATOR_USE_STATE_DIR, else simulator-use in the user's temporary folder. */
export const stateDir = () => setting("STATE_DIR") || join(tmpdir(), "simulator-use");
const heldFile = () => join(stateDir(), "held-device.json");

/** The CLI keeps the held device between its calls. */
export function persistHeld(): void {
  persist = true;
}

export const holdDevice = (udid: string) => {
  held = udid;
  if (!persist) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(heldFile(), JSON.stringify({ udid }));
  } catch {
    // The next call falls back to the booted device.
  }
};

export const heldDevice = () => {
  if (held || !persist) return held;
  try {
    const { udid } = JSON.parse(readFileSync(heldFile(), "utf8")) as { udid?: unknown };
    if (typeof udid === "string" && /^[0-9A-Fa-f-]{36}$/.test(udid)) held = udid;
  } catch {
    // None held yet.
  }
  return held;
};

/** Where simulator-use keeps a device's app output: the print() lines of apps it launched. */
export async function deviceDir(udid: string): Promise<string> {
  const dir = join(stateDir(), udid);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type CurrentApp = { bundleId: string; executable?: string; launchedAt?: number };

export async function currentApp(udid: string): Promise<CurrentApp | undefined> {
  try {
    return JSON.parse(await readFile(join(await deviceDir(udid), "app.json"), "utf8")) as CurrentApp;
  } catch {
    return undefined;
  }
}

export async function setCurrentApp(udid: string, app: CurrentApp): Promise<void> {
  await writeFile(join(await deviceDir(udid), "app.json"), JSON.stringify(app));
}

/**
 * A device's time zone as simulator-use sets it (app_control timezone): iOS has no setting a tool can change, so
 * every app simulator-use launches gets it as TZ.
 */
export async function deviceTimeZone(udid: string): Promise<string | undefined> {
  return (await deviceSettings(udid)).timeZone;
}

export async function setDeviceTimeZone(udid: string, timeZone: string | undefined): Promise<void> {
  await setDeviceSettings(udid, { timeZone });
}

/** The environment app_run gave the device's apps (env): every later launch passes it, as Xcode's scheme would. */
export async function deviceEnv(udid: string): Promise<Record<string, string>> {
  return (await deviceSettings(udid)).env ?? {};
}

export async function setDeviceEnv(udid: string, env: Record<string, string>): Promise<void> {
  await setDeviceSettings(udid, { env: Object.keys(env).length ? env : undefined });
}

type DeviceSettings = { timeZone?: string; env?: Record<string, string> };

async function deviceSettings(udid: string): Promise<DeviceSettings> {
  try {
    return JSON.parse(await readFile(join(await deviceDir(udid), "settings.json"), "utf8")) as DeviceSettings;
  } catch {
    return {};
  }
}

async function setDeviceSettings(udid: string, change: DeviceSettings): Promise<void> {
  const next: DeviceSettings = { ...(await deviceSettings(udid)), ...change };
  for (const key of Object.keys(next) as (keyof DeviceSettings)[]) if (next[key] === undefined) delete next[key];
  await writeFile(join(await deviceDir(udid), "settings.json"), JSON.stringify(next));
}
