import { setting } from "./settings.ts";

/**
 * Where simulator-use can't run (no Mac, no Xcode, no Simulator runtime), the agent is told it can run the same
 * tools on a cloud phone: cloud mode, on NoMac, which makes simulator-use. Never shown when simulator-use works;
 * SIMULATOR_USE_NO_CLOUD_HINT=1 hides it.
 */
export const NOMAC_URL = "https://nomac.app/?utm_source=simulator-use";

export function cloudHint(): string {
  if (setting("NO_CLOUD_HINT")) return "";
  return `No Mac to run it on? The cloud tool (simulator-use cloud start) runs the same tools on a NoMac cloud iPhone Simulator, $0.80 an hour by the minute: ${NOMAC_URL}`;
}

/** A next step, with the hint after it when it is on. */
export const withCloudHint = (next: string) => [next, cloudHint()].filter(Boolean).join(" ");

/** The next step on a machine that can't run the iOS Simulator: a cloud phone first, when the hint is on. */
export function cloudFirst(otherwise: string): string {
  return setting("NO_CLOUD_HINT") ? otherwise : `cloud start runs every tool on a NoMac cloud iPhone Simulator, $0.80 an hour by the minute (${NOMAC_URL}); then call this again. Or: ${otherwise.replace(/^./, (c) => c.toLowerCase())}`;
}
