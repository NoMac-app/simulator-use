import { setTimeout as sleep } from "node:timers/promises";

import { AccessibilityStarting, batch, describeScreen, describeUi, gesture } from "../engine/axe.ts";
import { engineCall, engineGesture, engineSteps, hasEngine } from "../engine/native.ts";
import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import { type AxNode, render, type Snapshot, snapshot } from "./snapshot.ts";

/** Right after a launch the app's accessibility tree is empty for a moment (seen on Xcode 27). */
const NOT_READY_RETRIES = 4;
const NOT_READY_WAIT_MS = 750;
const SETTLE_START_MS = 120;
const SETTLE_TIMEOUT_MS = 4_000;
/** After an input, how long the screen may take to start changing. */
const FIRST_CHANGE_MS = 800;
/** Still for this long, the screen is done changing. */
const QUIET_MS = 150;
/**
 * The engine starts its read once the screen has been still for READ_START_MS, and keeps the read only if nothing
 * changed while it ran and for READ_GUARD_MS after (what changes during a read is drawn a frame or two later) and the
 * screen was still for QUIET_MS in all: the read overlaps the end of the wait instead of following it.
 */
const READ_START_MS = 50;
const READ_GUARD_MS = 35;

export type Screen = { tree: AxNode[]; snap: Snapshot; reused?: string };

/** How long a call keeps trying while accessibility starts, leaving room in the 45 s a call may take. */
const STARTING_BUDGET_MS = 35_000;

/** Reads the tree, waiting out a starting accessibility service for up to 35 s before giving up. */
async function describeWhenReady(udid: string, options: ReadOptions): Promise<{ tree: AxNode[]; reused?: string }> {
  const deadline = Date.now() + STARTING_BUDGET_MS;
  for (;;) {
    try {
      return await describeScreen(udid, options);
    } catch (error) {
      if (!(error instanceof AccessibilityStarting) || Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
}

/**
 * The screen now. With reuse, the engine's last read may come back when the screen's pixels are as they were then
 * (a caret's blink aside) and a few of its elements, read again one point each, agree (reused says so).
 */
export type ReadOptions = {
  /** The engine's last read again, when the screen has not changed since (see readScreen). */
  reuse?: boolean;
  /** Every attribute of every element (ui_look's full tree), not only what the screen's text uses. */
  full?: boolean;
};

export async function readScreen(udid: string, waitUntilReady = true, options: ReadOptions = {}): Promise<Screen> {
  const first = await describeWhenReady(udid, options);
  let tree = first.tree;
  let snap = snapshot(tree);
  for (let i = 0; waitUntilReady && i < NOT_READY_RETRIES && !snap.elements.length && !snap.tabs.length; i++) {
    await sleep(NOT_READY_WAIT_MS);
    tree = await describeUi(udid, { full: options.full });
    snap = snapshot(tree);
  }
  return { tree, snap, ...(first.reused && tree === first.tree ? { reused: first.reused } : {}) };
}

/** An app that just came to the front shows its frame before its contents: mostly unreadable, almost nothing listed. */
function opening(snap: Snapshot, fromApp?: string): boolean {
  if (fromApp === undefined || snap.app === fromApp || snap.elements.length > 3) return false;
  const screen = snap.screen.width * snap.screen.height;
  return snap.unreadable.some((f) => f.width * f.height > 0.6 * screen);
}

/** An input to send before the wait: AXe batch steps (`tap -x 1 -y 2`), or AXe's swipe or drag arguments. */
export type Input = { steps: string[] } | { gesture: string[] };

/** The input as the engine takes it, or undefined when it can't (the input then goes the old way). */
function engineInput(input: Input): Record<string, unknown> | undefined {
  if ("steps" in input) {
    const steps = engineSteps(input.steps);
    return steps ? { op: "steps", steps } : undefined;
  }
  return engineGesture(input.gesture);
}

async function send(udid: string, input: Input): Promise<void> {
  if ("steps" in input) await batch(udid, input.steps);
  else await gesture(udid, input.gesture);
}

export type SettleOptions = {
  /** How long to wait for the first change (default 0.8 s; 0: the screen is taken as changing already). */
  firstChangeMs?: number;
  /** "kept": a change is a difference from the screen last read, not from the screen as the wait starts. */
  baseline?: "kept";
  /** How long the screen may keep changing before it is read as it is (default 4 s). */
  timeoutMs?: number;
};

/**
 * Sends the input (if any), then waits for the screen to stop changing, and reads it. `settled: false` means it was
 * still moving at the timeout (an animation, a ticker, a spinner).
 *
 * With the engine, one request does it all: the input, a wait for the first change (up to 0.8 s), then for the screen
 * to hold still, judged from where its pixels change (a caret blinking in a text field is not a change), and a read
 * that is kept only if the screen held still through it. A newly opened app's shell is read again until its contents
 * arrive (up to 2.5 s).
 */
export async function settle(udid: string, fromApp?: string, input?: Input, options: SettleOptions = {}): Promise<{ snap: Snapshot; settled: boolean }> {
  const started = Date.now();
  const request = input && engineInput(input);
  let sent = false;
  if ((!input || request) && (await hasEngine(udid))) {
    const answer = await engineCall(
      udid,
      {
        op: "settle_read",
        lean: true,
        ...(request ? { input: request } : {}),
        first_change_ms: options.firstChangeMs ?? FIRST_CHANGE_MS,
        quiet_ms: QUIET_MS,
        start_ms: READ_START_MS,
        guard_ms: READ_GUARD_MS,
        timeout_ms: options.timeoutMs ?? SETTLE_TIMEOUT_MS,
        ...(options.baseline ? { baseline: options.baseline } : {}),
      },
      // The wait, then a read, which can take long on a web page.
      (options.firstChangeMs ?? FIRST_CHANGE_MS) + (options.timeoutMs ?? SETTLE_TIMEOUT_MS) + 60_000,
      { reportLost: true },
    );
    if (answer?.ok && answer.tree) {
      const tree = answer.tree as AxNode | AxNode[];
      let snap = snapshot(Array.isArray(tree) ? tree : [tree]);
      const quiet = Date.now();
      let reads = 0;
      for (const deadline = Date.now() + 2_500; opening(snap, fromApp) && Date.now() < deadline; reads++) {
        await sleep(300);
        snap = (await readScreen(udid, false)).snap;
      }
      if (setting("DEBUG")) {
        const readMs = (answer.read_ms as number[] | undefined)?.join("+") ?? "?";
        process.stderr.write(`simulator-use:   settle ${quiet - started} ms${answer.settled === false ? " (still changing)" : ""}${answer.changed === false ? " (no change)" : ""}: first change ${answer.first_change_ms} ms, ${answer.reads} read(s) ${readMs} ms, ${answer.dropped} dropped${reads ? `, ${reads} more read(s) ${Date.now() - quiet} ms` : ""}\n`);
      }
      return { snap, settled: answer.settled !== false };
    }
    // The engine is still at it after a minute (busy): the input went out, or will; it is never sent again.
    if (answer?.busy) {
      if (input) throw new ToolError("The Simulator did not finish the input and the wait after it within a minute.", "Call ui_look to see the screen: the phone may still be busy with it.");
      return { snap: (await readScreen(udid, false)).snap, settled: false };
    }
    // The input is sent the old way only when it surely did not go out: no engine took the request, an engine from
    // before settle_read refused it (unknown op), or this one refused it before sending it (input_sent false). An
    // engine that stopped after the request went out (lost), or an error after the input (input_sent), sent it.
    sent = Boolean(answer && (answer.lost || !(answer.input_sent === false || /unknown op/.test(String(answer.error ?? "")))));
  }
  if (input && !sent) await send(udid, input);
  return settleAfter(udid, fromApp, started, options.firstChangeMs ?? FIRST_CHANGE_MS);
}

/** How long a read after typing waits for the screen to hold still (the text drawn, a field's caret aside). */
const STILL_READ_MS = 400;

/**
 * The screen once it holds still for a moment (up to 0.4 s, then as it is): with the engine, a read it can give
 * again to the next call while nothing changes; without it, a plain read.
 */
export async function readWhenStill(udid: string): Promise<Snapshot> {
  if (await hasEngine(udid)) {
    const answer = await engineCall(udid, { op: "settle_read", lean: true, first_change_ms: 0, quiet_ms: QUIET_MS, start_ms: READ_START_MS, guard_ms: READ_GUARD_MS, timeout_ms: STILL_READ_MS }, STILL_READ_MS + 60_000);
    if (answer?.ok && answer.tree) {
      const tree = answer.tree as AxNode | AxNode[];
      if (setting("DEBUG")) process.stderr.write(`simulator-use:   read when still: ${answer.waited_ms} ms, ${answer.reads} read(s) ${(answer.read_ms as number[] | undefined)?.join("+") ?? "?"} ms, ${answer.dropped} dropped${answer.settled === false ? " (still changing)" : ""}\n`);
      return snapshot(Array.isArray(tree) ? tree : [tree]);
    }
  }
  return (await readScreen(udid, false)).snap;
}

/** The wait without the engine's settle_read: its settle request, else reads until two in a row look the same. */
async function settleAfter(udid: string, fromApp: string | undefined, started: number, firstChangeMs: number): Promise<{ snap: Snapshot; settled: boolean }> {
  const answer = await engineCall(udid, { op: "settle", first_change_ms: firstChangeMs, quiet_ms: QUIET_MS, timeout_ms: SETTLE_TIMEOUT_MS }, firstChangeMs + SETTLE_TIMEOUT_MS + 5_000);
  if (answer?.ok) {
    const quiet = Date.now();
    let snap = (await readScreen(udid, false)).snap;
    let reads = 1;
    for (const deadline = Date.now() + 2_500; opening(snap, fromApp) && Date.now() < deadline; reads++) {
      await sleep(300);
      snap = (await readScreen(udid, false)).snap;
    }
    if (setting("DEBUG")) process.stderr.write(`simulator-use:   settle ${quiet - started} ms${answer.settled === false ? " (still changing)" : ""}, ${reads} read(s) ${Date.now() - quiet} ms\n`);
    return { snap, settled: answer.settled !== false };
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  await sleep(SETTLE_START_MS);
  let last = (await readScreen(udid, false)).snap;
  while (Date.now() < deadline) {
    const next = (await readScreen(udid, false)).snap;
    if (render(next) === render(last)) return { snap: next, settled: true };
    last = next;
  }
  return { snap: last, settled: false };
}
