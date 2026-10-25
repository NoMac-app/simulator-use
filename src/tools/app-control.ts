import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { appInfo, BUNDLE_ID, bundleIdOf, install, pushPayload, simctlAction, stopLogStream } from "../engine/apps.ts";
import { listDevices, pickDevice } from "../engine/simctl.ts";
import { engineCall } from "../engine/native.ts";
import { currentApp, heldDevice, setCurrentApp, setDeviceTimeZone } from "../engine/state.ts";
import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import { readScreen } from "../look/read.ts";
import { render } from "../look/snapshot.ts";
import { grantAll, openInPrompt, setPermissionMode } from "../engine/prompts.ts";
import { launchAndLook, tapPrompt } from "./launch-app.ts";
import type { Tool } from "./types.ts";

/**
 * A link opens through the engine, which reads it from its input: simctl openurl takes it as an argument, which every
 * user of a Mac can read, so a shared host (SIMULATOR_USE_HOSTED) never falls back to it.
 */
export async function openUrl(udid: string, url: string): Promise<void> {
  const answer = await engineCall(udid, { op: "open_url", url }, 20_000);
  if (answer?.ok) return;
  if (setting("HOSTED")) throw new ToolError(`Could not open the link${answer?.error ? `: ${answer.error}` : ""}.`, "Check it is a full link with its scheme (https://, or the app's own), then try again.");
  await simctlAction(["openurl", udid, url], "open the link");
}

const ACTIONS = ["launch", "install", "terminate", "uninstall", "open_url", "grant", "revoke", "reset_permissions", "location", "push", "appearance", "locale", "timezone", "text_size", "status_bar"];
/** simctl ui content_size's sizes. */
const TEXT_SIZES = ["extra-small", "small", "medium", "large", "extra-large", "extra-extra-large", "extra-extra-extra-large",
  "accessibility-medium", "accessibility-large", "accessibility-extra-large", "accessibility-extra-extra-large", "accessibility-extra-extra-extra-large"];
/** What simctl privacy takes (its help, plus camera, which it also accepts). */
const PERMISSIONS = ["all", "calendar", "camera", "contacts", "contacts-limited", "location", "location-always", "media-library", "microphone", "motion", "photos", "photos-add", "reminders", "siri"];

/** What `value` holds for each action that needs one. */
const VALUE: Record<string, string> = {
  open_url: "a URL or deep link",
  grant: "a permission: photos, photos-add, location, location-always, contacts, camera, microphone, calendar, reminders, motion, media-library, siri or all",
  revoke: "a permission, as for grant",
  location: '"latitude,longitude", or "clear"',
  push: 'the notification text, or a JSON payload with "aps"',
  appearance: '"light" or "dark"',
  locale: 'a language and region, like "fr_FR", "pt-BR" or "zh-Hans_CN"',
  timezone: 'an IANA time zone, like "Europe/Paris", or "clear"',
  text_size: `one of ${TEXT_SIZES.join(", ")}`,
  status_bar: '"clean" (9:41, full signal and battery, for screenshots) or "clear"',
};

/** A locale as iOS keeps it: the language for AppleLanguages ("pt-BR") and the locale for AppleLocale ("pt_BR"). */
export function localeParts(value: string): { language: string; locale: string } {
  const m = /^\s*([a-z]{2,3})(?:[-_]([A-Z][a-z]{3}))?(?:[-_]([A-Z]{2}|\d{3}))?\s*$/.exec(value);
  if (!m) throw new ToolError(`"${value}" is not a language and region.`, 'For example "fr_FR", "pt-BR", "zh-Hans_CN" or "en".');
  const [, lang, script, region] = m;
  return { language: [lang, script, region].filter(Boolean).join("-"), locale: [[lang, script].filter(Boolean).join("-"), region].filter(Boolean).join("_") };
}

/** An IANA time zone this machine knows (Intl refuses any other). */
export function timeZoneName(value: string): string {
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    if (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return zone;
  } catch {
    // Not a time zone.
  }
  throw new ToolError(`"${value}" is not a time zone.`, 'Use an IANA name, like "Europe/Paris" or "America/New_York".');
}

/** A push from plain text, or the agent's own JSON payload, checked the way simctl will. */
export function pushJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return JSON.stringify({ aps: { alert: trimmed, sound: "default" } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ToolError("The push payload is not valid JSON.", 'Send plain text, or JSON such as {"aps": {"alert": "Hello"}}.');
  }
  if (!parsed || typeof parsed !== "object" || !("aps" in parsed)) throw new ToolError('A push payload needs an "aps" object.', 'For example {"aps": {"alert": "Hello"}}.');
  if (Buffer.byteLength(trimmed) > 4096) throw new ToolError("The push payload is over 4 KB, the limit for a push.");
  return trimmed;
}

export const appControl: Tool = {
  name: "app_control",
  title: "Control an app",
  description:
    "Launch, install, stop or remove an app on the Simulator; open a URL or deep link; grant, revoke or reset a permission; set the location; send a push; set the phone's appearance, locale, time zone, text size or a clean status bar. launch answers with the app's first screen; later calls default to the app launched last.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: "What to do" },
      app: { type: "string", description: "Bundle id, or for install the path to a Simulator .app" },
      value: { type: "string", description: "URL, permission, lat,long, push text/JSON, light/dark, locale (fr_FR), time zone (Europe/Paris), text size or clean/clear, per action" },
      device: { type: "string", description: "Name or UDID; default: the one in use" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  command: "app",
  positional: ["action", "value"],
  async run(args) {
    const action = args.action as string;
    const device = pickDevice(await listDevices(), args.device as string | undefined, heldDevice());
    const label = `${device.name} (${device.runtime})`;
    // Actions without a value take the app as their one word: `simulator-use app launch dev.example.app`.
    const takesValue = Boolean(VALUE[action]) || action === "reset_permissions";
    const value = takesValue ? (args.value as string | undefined) : undefined;
    const app = (args.app as string | undefined) ?? (takesValue ? undefined : (args.value as string | undefined));
    if (VALUE[action] && !value) throw new ToolError(`${action} needs value: ${VALUE[action]}.`);

    if (action === "install") {
      const path = app ? resolvePath(app) : "";
      if (!path || !existsSync(path)) throw new ToolError("install needs app: the path to a .app built for the Simulator.", "Build with xcodebuild -sdk iphonesimulator; the .app is under Build/Products/Debug-iphonesimulator.");
      const bundleId = await bundleIdOf(path);
      await install(device.udid, path, device.runtime);
      const info = await appInfo(device.udid, bundleId);
      await setCurrentApp(device.udid, { bundleId, executable: info?.executable });
      const refused = await grantAll(device.udid, bundleId);
      const granted = refused ? ` Its permissions could not be granted (${refused}).` : " Its permissions are granted, so no prompt stops it (reset_permissions brings iOS's prompts back).";
      return { text: `Installed ${info?.name ?? bundleId} (${bundleId}) on ${label}.${granted} Next: app_control {action: "launch"}.` };
    }

    // Every other action works on an installed app: the one named, or the one launched last.
    const bundleId = app ?? (await currentApp(device.udid))?.bundleId;
    if (bundleId && !BUNDLE_ID.test(bundleId)) throw new ToolError(`"${bundleId}" is not a bundle id.`, "A bundle id looks like com.example.app; install takes the path to a .app.");
    // The phone's own settings need no app.
    const needsApp = !["open_url", "location", "reset_permissions", "appearance", "locale", "timezone", "text_size", "status_bar"].includes(action);
    if (needsApp && !bundleId) throw new ToolError(`${action} needs app: the bundle id.`, "Pass app, or launch the app first.");

    switch (action) {
      case "launch":
        return { text: await launchAndLook(device, bundleId!) };
      case "terminate":
        await simctlAction(["terminate", device.udid, bundleId!], `stop ${bundleId}`).catch((error: ToolError) => {
          if (!/found nothing to terminate|not running/i.test(error.message)) throw error;
        });
        return { text: `Stopped ${bundleId}.` };
      case "uninstall":
        await stopLogStream(device.udid, bundleId!);
        await simctlAction(["uninstall", device.udid, bundleId!], `remove ${bundleId}`);
        return { text: `Removed ${bundleId} and its data from ${label}.` };
      case "open_url": {
        await openUrl(device.udid, value!);
        let snap = (await readScreen(device.udid)).snap;
        // A link that opens another app makes iOS ask "Open in “App”?": the agent asked for exactly that.
        const asked = openInPrompt(snap);
        if (asked) snap = await tapPrompt(device, "Open");
        return { text: `Opened the link.${asked ? ` iOS asked "${asked}": answered Open.` : ""}\n${render(snap, { device: label })}` };
      }
      case "grant":
      case "revoke":
        if (!PERMISSIONS.includes(value!)) throw new ToolError(`Unknown permission "${value}".`, `Permissions: ${PERMISSIONS.join(", ")}.`);
        await simctlAction(["privacy", device.udid, action, value!, bundleId!], `${action} ${value}`);
        // A permission taken away is for testing iOS's prompt: launches stop answering prompts for this app.
        if (action === "revoke") await setPermissionMode(device.udid, bundleId!, "ask");
        return { text: `${action === "grant" ? "Granted" : "Revoked"} ${value} for ${bundleId}. The app may have been stopped: iOS does that when a permission changes.` };
      case "reset_permissions":
        await simctlAction(["privacy", device.udid, "reset", value ?? "all", ...(bundleId ? [bundleId] : [])], "reset permissions");
        if (bundleId) await setPermissionMode(device.udid, bundleId, "ask");
        return { text: `Reset ${value ?? "all"} permissions${bundleId ? ` for ${bundleId}` : ""}: the app asks again on next use.` };
      case "location": {
        if (value!.trim() === "clear") {
          await simctlAction(["location", device.udid, "clear"], "clear the location");
          return { text: "Cleared the simulated location." };
        }
        const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value!);
        if (!match || Math.abs(Number(match[1])) > 90 || Math.abs(Number(match[2])) > 180) throw new ToolError(`"${value}" is not latitude,longitude.`, 'For example "47.4979,19.0402".');
        await simctlAction(["location", device.udid, "set", `${match[1]},${match[2]}`], "set the location");
        return { text: `Location set to ${match[1]},${match[2]}.` };
      }
      case "push":
        await pushPayload(device.udid, bundleId!, pushJson(value!));
        return { text: `Sent a push to ${bundleId}.` };
      case "appearance": {
        const mode = value!.trim().toLowerCase();
        if (mode !== "light" && mode !== "dark") throw new ToolError(`Appearance is "light" or "dark", not "${value}".`);
        await simctlAction(["ui", device.udid, "appearance", mode], "set the appearance");
        return { text: `${label} is in ${mode} mode.` };
      }
      case "locale": {
        const { language, locale } = localeParts(value!);
        await simctlAction(["spawn", device.udid, "defaults", "write", "-g", "AppleLanguages", "-array", language], "set the language");
        await simctlAction(["spawn", device.udid, "defaults", "write", "-g", "AppleLocale", "-string", locale], "set the region");
        return { text: `${label}'s language and region are ${language} (${locale}). Apps read them when they launch: relaunch the app (app_control launch).` };
      }
      case "timezone": {
        if (value!.trim() === "clear") {
          await setDeviceTimeZone(device.udid, undefined);
          return { text: `Apps launched from now on run in this Mac's time zone again; relaunch the app (app_control launch).` };
        }
        const zone = timeZoneName(value!);
        await setDeviceTimeZone(device.udid, zone);
        return { text: `Apps simulator-use launches from now on run in ${zone}: relaunch the app (app_control launch). The status bar's clock keeps this Mac's time.` };
      }
      case "text_size": {
        const size = value!.trim().toLowerCase();
        if (!TEXT_SIZES.includes(size)) throw new ToolError(`"${value}" is not a text size.`, `Use one of: ${TEXT_SIZES.join(", ")}.`);
        await simctlAction(["ui", device.udid, "content_size", size], "set the text size");
        return { text: `${label}'s text size is ${size}.` };
      }
      case "status_bar": {
        const mode = value!.trim().toLowerCase();
        if (mode === "clear") {
          await simctlAction(["status_bar", device.udid, "clear"], "clear the status bar");
          return { text: "The status bar shows the real time, signal and battery again." };
        }
        if (mode !== "clean") throw new ToolError(`status_bar is "clean" or "clear", not "${value}".`);
        await simctlAction(["status_bar", device.udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
          "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"], "set the status bar");
        return { text: "The status bar shows 9:41, full signal and a full battery, as App Store screenshots do." };
      }
      default:
        throw new ToolError(`Unknown action "${action}". Actions: ${ACTIONS.join(", ")}.`);
    }
  },
};
