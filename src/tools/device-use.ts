import { ToolError } from "../errors.ts";
import { bootDevice, defaultPhone, findDevice, listDevices, type Device } from "../engine/simctl.ts";
import { run } from "../engine/exec.ts";
import { engineCall, forgetUnavailable } from "../engine/native.ts";
import { axePath } from "../engine/axe.ts";
import { heldDevice, holdDevice } from "../engine/state.ts";
import type { Tool } from "./types.ts";
import { setting } from "../settings.ts";

/** At most this many booted at once when set; a cloud VM sets 1 (a 6-core, 8 GB VM drives one Simulator well). */
const maxBooted = () => Number(setting("MAX_BOOTED")) || Infinity;

const CLEAN_STATUS_BAR = ["--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"];

export const deviceUse: Tool = {
  name: "device_use",
  title: "Choose a Simulator",
  description:
    "Choose the Simulator the other tools use, booting it if needed (one boot at a time), and optionally set dark or light appearance, a clean status bar (9:41, full battery) for screenshots, or fold an iPhone Duo.",
  inputSchema: {
    type: "object",
    properties: {
      device: { type: "string", description: "Name, name with runtime (\"iPhone 17 Pro (iOS 27.0)\") or UDID; default: the booted one, else the newest iPhone" },
      appearance: { type: "string", enum: ["light", "dark"], description: "Light or dark mode" },
      status_bar: { type: "string", enum: ["clean", "real"], description: "clean: 9:41 and full bars; real: undo" },
      fold: { type: "string", enum: ["closed", "book", "open"], description: "iPhone Duo: answers once that screen is in use" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  command: "use",
  positional: ["device"],
  async run(args) {
    const devices = await listDevices(true);
    const booted = devices.filter((d) => d.booted);
    let device: Device | undefined;
    if (args.device) {
      device = findDevice(devices, args.device as string);
      if (!device) throw new ToolError(`No Simulator named "${args.device}".`, "Call devices to see the names and UDIDs on this Mac.");
    } else {
      device = booted.find((d) => d.udid === heldDevice()) ?? (booted.length === 1 ? booted[0] : undefined) ?? devices.find(defaultPhone) ?? devices.find((d) => d.name.startsWith("iPhone"));
      if (!device) throw new ToolError("This Mac has no iPhone Simulator.", "Add an iOS runtime in Xcode > Settings > Components, or pass device.");
    }

    const lines: string[] = [];
    if (!device.booted) {
      const boot = await bootDevice(device, maxBooted());
      if (boot.waitedMs > 1_000) lines.push(`Waited ${(boot.waitedMs / 1000).toFixed(0)} s for another Simulator to finish booting: boots never overlap.`);
      if (boot.shutDown.length) lines.push(`Shut down ${boot.shutDown.join(", ")} first: this Mac runs ${maxBooted()} at a time.`);
      if (!boot.ready) {
        holdDevice(device.udid);
        lines.push(`Booting ${device.name} (${device.runtime}) took longer than this call may wait (${(boot.ms / 1000).toFixed(0)} s so far); a first boot can take a minute or two.`, `Next: call device_use {device: "${device.udid}"} again in 30 s.`);
        return { text: lines.join("\n"), isError: true };
      }
      lines.push(`Booted ${device.name} (${device.runtime}) in ${(boot.ms / 1000).toFixed(1)} s.`);
    }
    holdDevice(device.udid);
    if (args.appearance) {
      await run("xcrun", ["simctl", "ui", device.udid, "appearance", args.appearance as string], { timeoutMs: 15_000 });
      lines.push(`Appearance: ${args.appearance}.`);
    }
    if (args.status_bar === "clean") {
      await run("xcrun", ["simctl", "status_bar", device.udid, "override", ...CLEAN_STATUS_BAR], { timeoutMs: 15_000 });
      lines.push("Status bar: 9:41, full Wi-Fi, signal and battery.");
    } else if (args.status_bar === "real") {
      await run("xcrun", ["simctl", "status_bar", device.udid, "clear"], { timeoutMs: 15_000 });
      lines.push("Status bar: real values.");
    }
    if (args.fold) {
      const folded = await fold(device, args.fold as string);
      if (folded.isError) return { text: [...lines, folded.text].join("\n"), isError: true };
      lines.push(folded.text);
    }
    lines.push(`Using ${device.name} (${device.runtime}, ${device.udid}); the other tools use it from now on.`);
    return { text: lines.join("\n") };
  },
};

/** What the engine names the screen in use: "inner screen 669x951". */
export function screenWords(screen: unknown): string | undefined {
  const s = screen as { role?: string; width?: number; height?: number; scale?: number } | undefined;
  if (!s?.role || !s.width || !s.height) return undefined;
  const scale = s.scale && s.scale > 0 ? s.scale : 1;
  return `${s.role} screen ${Math.round(s.width / scale)}x${Math.round(s.height / scale)}`;
}

/** Why a fold failed, by the engine's code, and what to do. */
const FOLD_ERRORS: Record<string, string> = {
  unsupported: "This Simulator does not fold: only an iPhone Duo does.",
  busy: "The hinge is moving already.",
  boot_changed: "The Simulator restarted while it folded.",
  timeout: "The fold did not finish in time.",
};

/**
 * Folds an iPhone Duo (the engine's hinge op): closed is the outer screen, book (half open) and open the inner one.
 * The engine answers once that screen is in use and still: about 15 to 17 s after a close or an open on iOS 27.2.
 */
async function fold(device: Device, posture: string): Promise<{ text: string; isError?: boolean }> {
  if (!device.foldable) return { text: `${device.name} does not fold: only an iPhone Duo does.`, isError: true };
  const answer = await engineCall(device.udid, { op: "hinge", posture, timeout_ms: 35_000 }, 80_000, { reportLost: true });
  // No engine for this phone (one cannot start while its display report is not steady, as after a fold cut off
  // midway): AXe's own hinge, as every tool falls back to AXe without the engine; moving the hinge settles the report.
  if (!answer) return await foldWithAxe(device, posture);
  if (answer.busy) return { text: "The fold took more than 50 s.", isError: true };
  if (!answer.ok) {
    const code = String(answer.code ?? "");
    return { text: `${FOLD_ERRORS[code] ?? "Could not fold."} ${answer.error ?? ""}`.trim() + "\nNext: ui_look to see the screen in use, then try again.", isError: true };
  }
  const screen = screenWords(answer.screen) ?? "screen";
  const seconds = typeof answer.ms === "number" ? ` in ${(answer.ms / 1000).toFixed(1)} s` : "";
  // From closed, book goes by way of open (the engine says so): iOS 27.2's Duo does not settle half opened from closed.
  const via = typeof answer.via === "string" ? ` by way of ${answer.via}` : "";
  return { text: answer.already && !via ? `Already ${posture}: the ${screen} is in use.` : `Folded ${posture}${via}${seconds}: the ${screen} is in use; earlier positions no longer hold.` };
}

/** AXe's hinge (its CLI): book is its "tabletop". Then the engine may start again. */
async function foldWithAxe(device: Device, posture: string): Promise<{ text: string; isError?: boolean }> {
  try {
    const started = Date.now();
    await run(axePath(), ["hinge", "set", posture === "book" ? "tabletop" : posture, "--udid", device.udid], { timeoutMs: 45_000 });
    forgetUnavailable(device.udid);
    return { text: `Folded ${posture} in ${((Date.now() - started) / 1000).toFixed(1)} s (by AXe; the screen in use may take up to 20 s more to follow): call ui_look to see it.` };
  } catch (error) {
    return { text: `Could not fold: ${(error as Error).message.split("\n")[0]}\nNext: call device_use with fold again in a few seconds.`, isError: true };
  }
}
