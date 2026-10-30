import { setTimeout as sleep } from "node:timers/promises";

import { appInfo, launch, startLogStream } from "../engine/apps.ts";
import { AccessibilityStarting } from "../engine/axe.ts";
import { alertTitle, permissionMode, permissionPrompt } from "../engine/prompts.ts";
import type { Device } from "../engine/simctl.ts";
import { setCurrentApp } from "../engine/state.ts";
import { ToolError } from "../errors.ts";
import { readScreen, settle } from "../look/read.ts";
import { render, type Snapshot } from "../look/snapshot.ts";
import { uiAct } from "./ui-act.ts";

/** How long launch waits for the app to come to the front, then after a second launch: within the 45 s of a call. */
const FRONT_WAIT_MS = 12_000;
const RELAUNCH_WAIT_MS = 15_000;
const LAUNCH_BUDGET_MS = 42_000;

/**
 * Launches an installed app fresh, with its print output and own log lines kept for app_logs, and answers with
 * its first screen. The launch returns before the app is in front: on iOS 27 in a VM, the home screen still
 * showed seconds later, and right after a crash the app once stayed behind for over 20 s. So: wait, then launch
 * once more if there is time.
 */
export async function launchAndLook(device: Device, bundleId: string, args: string[] = []): Promise<string> {
  const label = `${device.name} (${device.runtime})`;
  const info = await appInfo(device.udid, bundleId);
  if (!info) throw new ToolError(`${bundleId} is not installed on ${label}.`, 'Install it with app_control {action: "install", app: "path/to/App.app"}.');
  const started = Date.now();
  if (info.executable) await startLogStream(device.udid, bundleId, info.executable);
  let running = await launch(device.udid, bundleId, args);
  await setCurrentApp(device.udid, { bundleId, executable: info.executable, launchedAt: started });
  const name = info.name ?? info.executable ?? bundleId;
  // In front: the app itself, or the app under one of iOS's prompts ("Name · system alert"). Not "Name · system
  // screen": that is iOS still animating the launch, the app's card behind it (Xcode 27 VM, October 19).
  const front = (app: string) => app === name || app === `${name} · system alert`;
  const withArgs = args.length ? ` with ${args.length} argument${args.length === 1 ? "" : "s"}` : "";
  const launched = () => `Launched ${name}${withArgs} in ${((Date.now() - started) / 1000).toFixed(1)} s`;
  const inFront = async (until: number) => {
    let { snap } = await readScreen(device.udid);
    while (!front(snap.app) && Date.now() < until) {
      await sleep(500);
      snap = (await readScreen(device.udid)).snap;
    }
    return snap;
  };
  // Not in front and its process gone: it quit right after launch, which is a crash (launching it again would too).
  const quit = () => new ToolError(`${name} quit right after it launched (its process ended within ${((Date.now() - started) / 1000).toFixed(0)} s): most likely a crash.`, "app_logs {crashes: true} shows where it crashed (file and line), and app_logs its print output.");
  try {
    let snap = await inFront(started + FRONT_WAIT_MS);
    if (!front(snap.app) && running.ended()) throw quit();
    let again = "";
    // Only while the call has time for it: a cold Simulator's first read alone can take 35 s.
    if (!front(snap.app) && Date.now() - started < LAUNCH_BUDGET_MS - RELAUNCH_WAIT_MS) {
      running = await launch(device.udid, bundleId, args);
      snap = await inFront(Date.now() + RELAUNCH_WAIT_MS);
      if (!front(snap.app) && running.ended()) throw quit();
      again = " (launched twice: it was not in front after the first)";
    }
    // In front is not finished: right after launch a SwiftUI stepper's buttons joined the tree a read later.
    for (let i = 0; i < 3 && front(snap.app); i++) {
      await sleep(400);
      const next = (await readScreen(device.udid, false)).snap;
      if (render(next) === render(snap)) break;
      snap = next;
    }
    // An app run with its permissions granted gets its first launch's prompts answered (notifications have no
    // simctl grant); app_run with permissions: "ask" leaves them, for testing them.
    const answered: string[] = [];
    if ((await permissionMode(device.udid, bundleId)) === "grant") {
      for (let prompt = permissionPrompt(snap, name); prompt && answered.length < 3; prompt = permissionPrompt(snap, name)) {
        snap = await tapPrompt(device, prompt.allow);
        answered.push(`"${prompt.title}" (${prompt.allow})`);
      }
    }
    const prompts = answered.length ? `\nAnswered iOS's prompt${answered.length > 1 ? "s" : ""} ${answered.join(", ")}; app_run with permissions: "ask" keeps them.` : "";
    const late = front(snap.app) ? "" : `\n${name} is not in front yet.\nNext: ui_look shortly, or launch again.`;
    return `${launched()}${again}.${prompts}${late}\n${render(snap, { device: label })}`;
  } catch (error) {
    // The launch worked; only reading the screen isn't possible yet (a first boot's accessibility service took
    // over 35 s on a fresh Xcode 27 Mac). That is not a failed launch.
    if (!(error instanceof AccessibilityStarting)) throw error;
    return `${launched()}. Its screen can't be read yet: the Simulator's accessibility service is still starting, as it does for a minute or two after a first boot.\nNext: ui_look in 30 seconds.`;
  }
}

/**
 * Taps one button of an iOS prompt the way ui_act taps (its lock, its settle), and reads the screen after. The
 * prompt is let finish coming up first, and tapped again while it is still in front: on iOS 27 a tap as "Open in
 * “EdgeLab”?" appeared was lost, and the prompt stayed (Texas, October 23).
 */
export async function tapPrompt(device: Device, label: string): Promise<Snapshot> {
  let snap = (await settle(device.udid)).snap;
  const title = alertTitle(snap);
  for (let attempt = 0; attempt < 3 && title !== undefined && alertTitle(snap) === title; attempt++) {
    await uiAct.run({ steps: [`tap "${label}"`], device: device.udid }, { waitForJobs: false });
    snap = (await readScreen(device.udid)).snap;
    if (alertTitle(snap) === title) snap = (await settle(device.udid)).snap;
  }
  return snap;
}
