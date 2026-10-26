import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "../errors.ts";
import type { AxNode, Frame } from "../look/snapshot.ts";
import { run } from "./exec.ts";
import { engineCall, noteSessionClosed, engineGesture, engineSteps } from "./native.ts";
import { setting } from "../settings.ts";

/**
 * AXe (MIT, github.com/cameroncooke/AXe) reads the Simulator's accessibility tree and sends touches and keys,
 * with no test runner to build. The package carries a pinned copy in vendor/axe; SIMULATOR_USE_AXE overrides it.
 */
export function axePath(): string {
  const override = setting("AXE");
  if (override) return override;
  // src/engine and dist/engine are both two levels below the package root.
  const bundled = fileURLToPath(new URL("../../vendor/axe/axe", import.meta.url));
  return existsSync(bundled) ? bundled : "axe";
}

/**
 * After a Simulator's first boot, its accessibility service takes a while to accept a reader: on a fresh
 * Xcode 27 Mac, describe-ui failed with this for about 75 s, then worked.
 */
export class AccessibilityStarting extends ToolError {}
// Also right after a boot: "No translation object returned for simulator" (iPhone 17e, 5 s after booting).
const STARTING = /remote automation session|No translation object returned/i;

export async function describeUi(udid: string): Promise<AxNode[]> {
  // A web page's first read can take half a minute (Safari, iOS 27): the engine gets a minute.
  const answer = await engineCall(udid, { op: "describe" }, 60_000);
  if (answer?.ok) {
    const tree = answer.tree as AxNode | AxNode[];
    return Array.isArray(tree) ? tree : [tree];
  }
  if (answer?.busy) throw new ToolError("Reading the screen took more than a minute.", "Call ui_look again: the phone is still working on the last read.");
  if (answer && STARTING.test(answer.error ?? "")) {
    throw new AccessibilityStarting("The Simulator's accessibility service is still starting; after a first boot this can take a minute or two.", "Call again in 30 seconds.");
  }
  try {
    const { stdout } = await run(axePath(), ["describe-ui", "--udid", udid], { timeoutMs: 30_000 });
    noteSessionClosed(udid);
    const parsed = JSON.parse(stdout) as AxNode | AxNode[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    noteSessionClosed(udid);
    if ((error as { code?: unknown }).code === "ENOENT") throw new ToolError("AXe is missing from this install.", "Reinstall simulator-use, or set SIMULATOR_USE_AXE to an axe binary.");
    if (STARTING.test((error as Error).message)) {
      throw new AccessibilityStarting("The Simulator's accessibility service is still starting; after a first boot this can take a minute or two.", "Call again in 30 seconds.");
    }
    throw new ToolError(`Could not read the screen: ${(error as Error).message}`, "Wait a second and call ui_look again; if it keeps failing, check the Simulator is booted with devices.");
  }
}

/** A JPEG of the screen sized to points, so a point in the picture is a point to tap (402x874 is about 470 image tokens). */
export async function screenshot(udid: string, points: Frame): Promise<Buffer> {
  const sized = points.width > 0 && points.height > 0 ? { width: Math.round(points.width), height: Math.round(points.height) } : {};
  const answer = await engineCall(udid, { op: "screenshot", ...sized, quality: 0.7, inline: true });
  if (answer?.ok && typeof answer.jpeg_base64 === "string") return Buffer.from(answer.jpeg_base64, "base64");
  if (answer?.busy) throw new ToolError("The screenshot took more than 30 s.", "Take it again: the phone is still working on an earlier request.");
  const dir = await mkdtemp(join(tmpdir(), "simulator-use-"));
  try {
    const png = join(dir, "screen.png");
    const jpg = join(dir, "screen.jpg");
    await run(axePath(), ["screenshot", "--output", png, "--udid", udid], { timeoutMs: 30_000 });
    const size = points.width > 0 && points.height > 0 ? ["-z", String(Math.round(points.height)), String(Math.round(points.width))] : [];
    await run("sips", [...size, "-s", "format", "jpeg", "-s", "formatOptions", "70", png, "--out", jpg], { timeoutMs: 30_000 });
    return await readFile(jpg);
  } catch (error) {
    throw new ToolError(`Could not take a screenshot: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The screen at the device's full resolution, as a PNG in file: for a person, a report or a store, not the agent's eyes. */
export async function screenshotFile(udid: string, file: string): Promise<void> {
  const answer = await engineCall(udid, { op: "screenshot", png_path: file });
  if (answer?.ok && existsSync(file)) return;
  if (answer?.busy) throw new ToolError("The screenshot took more than 30 s.", "Take it again: the phone is still working on an earlier request.");
  try {
    await run(axePath(), ["screenshot", "--output", file, "--udid", udid], { timeoutMs: 30_000 });
  } catch (error) {
    throw new ToolError(`Could not take a screenshot: ${(error as Error).message}`);
  }
}

/**
 * Any AXe command may open and close an automation session of its own (a slider is found by its id), so each one is
 * followed by the time the next engine waits from (noteSessionClosed).
 */
const axe = (udid: string, args: string[], timeoutMs = 30_000) =>
  run(axePath(), [...args, "--udid", udid], { timeoutMs }).finally(() => noteSessionClosed(udid));

/** One AXe process for several input steps (tap, type, key, key-combo, swipe, sleep): about 0.2 s cheaper per step. */
export async function batch(udid: string, steps: string[]): Promise<void> {
  const native = engineSteps(steps);
  if (native) {
    const answer = await engineCall(udid, { op: "steps", steps: native }, 60_000);
    if (answer?.ok) return;
    if (answer?.busy) throw new ToolError("The Simulator did not take the input within a minute.");
  }
  try {
    await axe(udid, ["batch", "--ax-cache", "none", "--type-submission", "composite", ...steps.flatMap((s) => ["--step", s])], 60_000);
  } catch (error) {
    throw new ToolError(`The Simulator did not take the input: ${(error as Error).message}`);
  }
}

/** A drag or swipe on its own: AXe's batch takes swipe but not drag. */
export async function gesture(udid: string, args: string[]): Promise<void> {
  const native = engineGesture(args);
  if (native) {
    const answer = await engineCall(udid, native, 30_000);
    if (answer?.ok) return;
    if (answer?.busy) throw new ToolError("The Simulator did not take the gesture within 30 s.");
  }
  try {
    await axe(udid, args, 30_000);
  } catch (error) {
    throw new ToolError(`The Simulator did not take the gesture: ${(error as Error).message}`);
  }
}

/** The single element at a point, for reading back a field right after typing (about 0.15 s). */
export async function elementAt(udid: string, x: number, y: number): Promise<AxNode | undefined> {
  const answer = await engineCall(udid, { op: "point", x: Math.round(x), y: Math.round(y) }, 3_000);
  if (answer?.ok) {
    const element = answer.element as AxNode | AxNode[] | undefined;
    return Array.isArray(element) ? element[0] : element;
  }
  // Slow (a web field just focused answered in 4.2 s): the caller reads the whole screen instead.
  if (answer?.busy) return undefined;
  try {
    // Normally 0.15 s; on a fresh Xcode 27 VM some hung for 8 to 11 s, so a slow one is abandoned for a full read.
    const { stdout } = await axe(udid, ["describe-ui", "--point", `${Math.round(x)},${Math.round(y)}`], 3_000);
    noteSessionClosed(udid);
    const parsed = JSON.parse(stdout) as AxNode | AxNode[];
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    noteSessionClosed(udid);
    return undefined;
  }
}

/** A step string for AXe batch: text goes in single quotes, with any single quote escaped the shell way. */
export function typeStep(text: string): string {
  return `type '${text.replace(/'/g, `'\\''`)}'`;
}

export async function pressButton(udid: string, button: "home" | "lock"): Promise<void> {
  const answer = await engineCall(udid, { op: button, wait: false });
  if (answer?.ok) return;
  if (answer?.busy) throw new ToolError(`The ${button} button press was not answered within 30 s.`);
  await axe(udid, ["button", button]);
}

/** Sets a slider by accessibility id or label to a percent; AXe drags it there. */
export async function setSlider(udid: string, target: { id?: string; label?: string }, percent: number): Promise<void> {
  const by = target.id ? ["--id", target.id] : ["--label", target.label ?? ""];
  try {
    await axe(udid, ["slider", ...by, "--value", String(percent)]);
  } catch (error) {
    throw new ToolError(`Could not set the slider: ${(error as Error).message}`);
  }
}
