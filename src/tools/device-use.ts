import { ToolError } from "../errors.ts";
import { bootDevice, findDevice, listDevices, type Device } from "../engine/simctl.ts";
import { run } from "../engine/exec.ts";
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
    "Choose the Simulator the other tools use, booting it if needed (one boot at a time), and optionally set dark or light appearance and a clean status bar (9:41, full battery) for screenshots.",
  inputSchema: {
    type: "object",
    properties: {
      device: { type: "string", description: "Name, name with runtime (\"iPhone 17 Pro (iOS 27.0)\") or UDID; default: the booted one, else the newest iPhone" },
      appearance: { type: "string", enum: ["light", "dark"], description: "Light or dark mode" },
      status_bar: { type: "string", enum: ["clean", "real"], description: "clean: 9:41 and full bars; real: undo" },
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
      device = booted.find((d) => d.udid === heldDevice()) ?? (booted.length === 1 ? booted[0] : undefined) ?? devices.find((d) => d.name.startsWith("iPhone"));
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
    lines.push(`Using ${device.name} (${device.runtime}, ${device.udid}); the other tools use it from now on.`);
    return { text: lines.join("\n") };
  },
};
