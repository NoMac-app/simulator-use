import { withCloudHint } from "../cloud-hint.ts";
import { listDevices, xcodeVersion } from "../engine/simctl.ts";
import { describeXcodes, listXcodes } from "../engine/xcodes.ts";
import type { Tool } from "./types.ts";

const MAX_LINES = 40;

export const devices: Tool = {
  name: "devices",
  title: "List Simulators",
  description: "List the iOS Simulators on this Mac: name, runtime, UDID and which are booted, and its Xcodes. The other tools use the booted one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  command: "devices",
  async run() {
    const [list, xcode, xcodes] = await Promise.all([listDevices(true), xcodeVersion(), listXcodes()]);
    const lines = [`This Mac${xcode ? ` · ${xcode}` : ""}`];
    // More than one Xcode: app_run and tests_run take any of them (xcode).
    if (xcodes.length > 1) lines.push(`Xcodes: ${describeXcodes(xcodes)}`);
    for (const d of list.slice(0, MAX_LINES)) lines.push(`${d.booted ? "booted " : ""}${d.name} · ${d.runtime} · ${d.udid}`);
    if (list.length > MAX_LINES) lines.push(`… ${list.length - MAX_LINES} more (xcrun simctl list devices)`);
    const booted = list.filter((d) => d.booted);
    if (!list.length) lines.push(`No Simulators. ${withCloudHint("Add an iOS runtime in Xcode > Settings > Components.")}`);
    else if (!booted.length) lines.push(`None booted. Boot one: device_use {device: "${list[0]!.udid}"} (one boot at a time across agents on this Mac).`);
    else if (booted.length > 1) lines.push("Several are booted: pass device (name or UDID) to the other tools.");
    return { text: lines.join("\n") };
  },
};
