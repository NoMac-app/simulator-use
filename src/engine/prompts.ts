/**
 * iOS's prompts that stop an agent before it reaches the app it asked for: "Open in “Expo Go”?" when a link opens
 * another app, and the permission prompts an app shows on its first launch (notifications have no simctl grant).
 * Answered only where the agent asked for the outcome: a link it opened itself, or an app it ran with permissions
 * granted (app_run's default). With permissions: "ask" the prompts stay, for testing them.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Snapshot } from "../look/snapshot.ts";
import { simctlAction } from "./apps.ts";
import { deviceDir } from "./state.ts";

export type PermissionMode = "grant" | "ask";

const OPEN_IN = /^Open in “.+”\?$/;
// "Would Like to Access the Camera", "would like full access to your Photo Library" (iOS 26), "to use your location".
// iOS 27 words several of them "Allow “App” to access your photo library?" (seen November 22, 2026, with the buttons
// Select Photos, Allow Full Access and Don’t Allow).
const PERMISSION = /would like (to )?(send you notifications|access|full access|use|find and connect)|to use your location|to track your activity|^Allow “.+” to (access|use|find|track|send|connect)/i;
/** The button that gives the app what it asks, in the order iOS words it. */
const ALLOWING = ["Allow", "Allow While Using App", "Allow Full Access", "OK"];

const alertOf = (snap: Snapshot) => (snap.modal === "alert" ? snap.elements.find((e) => e.kind === "alert" && e.label) : undefined);
const button = (snap: Snapshot, label: string) => snap.elements.some((e) => e.kind === "button" && e.label === label);

/** The title of the alert in front, or nothing. */
export const alertTitle = (snap: Snapshot): string | undefined => alertOf(snap)?.label;

/** iOS's "Open in “App”?" in front, with its Open button: the title, or nothing. */
export function openInPrompt(snap: Snapshot): string | undefined {
  const alert = alertOf(snap);
  return alert && OPEN_IN.test(alert.label!) && button(snap, "Open") ? alert.label : undefined;
}

/** A permission prompt over the app (named as ui_look names it): its title and the button that allows, or nothing. */
export function permissionPrompt(snap: Snapshot, app: string): { title: string; allow: string } | undefined {
  if (snap.app !== `${app} · system alert`) return undefined;
  const alert = alertOf(snap);
  if (!alert || !PERMISSION.test(alert.label!)) return undefined;
  const allow = ALLOWING.find((label) => button(snap, label));
  return allow ? { title: alert.label!, allow } : undefined;
}

const modesFile = async (udid: string) => join(await deviceDir(udid), "permissions.json");

/** How an app was run on this Simulator: its permissions granted (prompts answered), or iOS asking. */
export async function permissionMode(udid: string, bundleId: string): Promise<PermissionMode | undefined> {
  try {
    const modes = JSON.parse(await readFile(await modesFile(udid), "utf8")) as Record<string, PermissionMode>;
    return modes[bundleId];
  } catch {
    return undefined;
  }
}

export async function setPermissionMode(udid: string, bundleId: string, mode: PermissionMode): Promise<void> {
  let modes: Record<string, PermissionMode> = {};
  try {
    modes = JSON.parse(await readFile(await modesFile(udid), "utf8")) as Record<string, PermissionMode>;
  } catch {
    // The first one.
  }
  modes[bundleId] = mode;
  await writeFile(await modesFile(udid), JSON.stringify(modes));
}

/**
 * Every permission the Simulator can grant the app (simctl privacy grant all: photos, location, contacts, camera,
 * microphone and the rest), recorded so its first launch's other prompts are answered too. Answers why it could
 * not, or nothing.
 */
export async function grantAll(udid: string, bundleId: string): Promise<string | undefined> {
  await setPermissionMode(udid, bundleId, "grant");
  try {
    await simctlAction(["privacy", udid, "grant", "all", bundleId], "grant its permissions");
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
