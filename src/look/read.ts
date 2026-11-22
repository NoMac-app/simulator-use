import { setTimeout as sleep } from "node:timers/promises";

import { AccessibilityStarting, batch, describeScreen, describeUi, enginePoint, type EngineScreen, gesture } from "../engine/axe.ts";
import { engineCall, engineGesture, engineSteps, hasEngine, screenRefusal } from "../engine/native.ts";
import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import { pagesListedNow, webAreas, withWebPages } from "../web/read.ts";
import { type AxNode, type Frame, render, type Snapshot, snapshot } from "./snapshot.ts";

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

export type Screen = { tree: AxNode[]; snap: Snapshot; reused?: string; notReused?: string; screen?: EngineScreen; posture?: string };

/** How long a call keeps trying while accessibility starts, leaving room in the 45 s a call may take. */
const STARTING_BUDGET_MS = 35_000;

/** Reads the tree, waiting out a starting accessibility service for up to 35 s before giving up. */
async function describeWhenReady(udid: string, options: ReadOptions & { noWebScan?: boolean }): Promise<{ tree: AxNode[]; reused?: string; notReused?: string; screen?: EngineScreen; posture?: string }> {
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

/**
 * A tree as it goes to the snapshot: its web views filled from their pages (web/read.ts). skipped: the engine was
 * asked to leave its own page scan out, since the Web Inspector listed a page; when the screen's web view then
 * turns out not to be one of those pages (another app's, one that does not let itself be inspected), the screen is
 * read once more with the scan.
 */
async function withPages(udid: string, tree: AxNode[], skipped: boolean, again: () => Promise<AxNode[]>): Promise<AxNode[]> {
  const started = Date.now();
  const filled = await withWebPages(udid, tree, (x, y) => enginePoint(udid, x, y));
  if (setting("DEBUG") && filled.merged) process.stderr.write(`simulator-use:   web: ${filled.merged.pages} page(s), ${filled.merged.items} element(s) in ${Date.now() - started} ms${filled.merged.placed ? ` (${filled.merged.placed})` : ""}${filled.merged.note ? ` (${filled.merged.note})` : ""}\n`);
  if (skipped && !filled.merged?.pages && webAreas(tree).length) return (await withWebPages(udid, await again())).tree;
  return filled.tree;
}

export async function readScreen(udid: string, waitUntilReady = true, options: ReadOptions = {}): Promise<Screen> {
  const noWebScan = pagesListedNow(udid);
  const first = await describeWhenReady(udid, { ...options, ...(noWebScan ? { noWebScan } : {}) });
  let tree = await withPages(udid, first.tree, noWebScan, async () => (await describeWhenReady(udid, { full: options.full })).tree);
  const given = tree;
  let snap = snapshot(tree);
  for (let i = 0; waitUntilReady && i < NOT_READY_RETRIES && !snap.elements.length && !snap.tabs.length; i++) {
    await sleep(NOT_READY_WAIT_MS);
    const skip = pagesListedNow(udid);
    tree = await withPages(udid, await describeUi(udid, { full: options.full, ...(skip ? { noWebScan: skip } : {}) }), skip, () => describeUi(udid, { full: options.full }));
    snap = snapshot(tree);
  }
  return {
    tree, snap, ...(first.reused && tree === given ? { reused: first.reused } : {}), ...(first.notReused ? { notReused: first.notReused } : {}),
    ...(first.screen ? { screen: first.screen } : {}), ...(first.posture ? { posture: first.posture } : {}),
  };
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
  /**
   * How long the screen must have been still before a read of it starts (default 50 ms). A read of an app that is
   * still launching waits on the app itself (1.7 to 2.5 s measured, against 0.1 to 0.3 s once it has drawn), so a
   * launch asks for a longer stillness than a gap between two frames of iOS's launch animation.
   */
  startMs?: number;
  /** Every change counts, a small one too (a launch: its first frames are small, an icon growing). */
  wholeStill?: boolean;
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
export async function settle(udid: string, fromApp?: string, input?: Input, options: SettleOptions = {}): Promise<{ snap: Snapshot; settled: boolean; changed?: boolean; animating?: Frame[] }> {
  const started = Date.now();
  const request = input && engineInput(input);
  let sent = false;
  const noWebScan = pagesListedNow(udid);
  if ((!input || request) && (await hasEngine(udid))) {
    const answer = await engineCall(
      udid,
      {
        op: "settle_read",
        lean: true,
        ...(request ? { input: request } : {}),
        first_change_ms: options.firstChangeMs ?? FIRST_CHANGE_MS,
        quiet_ms: Math.max(QUIET_MS, options.startMs ?? 0),
        start_ms: options.startMs ?? READ_START_MS,
        guard_ms: READ_GUARD_MS,
        timeout_ms: options.timeoutMs ?? SETTLE_TIMEOUT_MS,
        ...(options.baseline ? { baseline: options.baseline } : {}),
        ...(options.wholeStill ? { whole_still: true } : {}),
        ...(noWebScan ? { web: false } : {}),
        ...(setting("DEBUG") === "trace" ? { trace: true } : {}),
      },
      // The wait, then a read, which can take long on a web page.
      (options.firstChangeMs ?? FIRST_CHANGE_MS) + (options.timeoutMs ?? SETTLE_TIMEOUT_MS) + 60_000,
      { reportLost: true },
    );
    if (answer?.ok && answer.tree) {
      const tree = answer.tree as AxNode | AxNode[];
      let snap = snapshot(await withPages(udid, Array.isArray(tree) ? tree : [tree], noWebScan, async () => (await describeWhenReady(udid, {})).tree));
      const quiet = Date.now();
      let reads = 0;
      for (const deadline = Date.now() + 2_500; opening(snap, fromApp) && Date.now() < deadline; reads++) {
        await sleep(300);
        snap = (await readScreen(udid, false)).snap;
      }
      if (setting("DEBUG")) {
        const readMs = (answer.read_ms as number[] | undefined)?.join("+") ?? "?";
        process.stderr.write(`simulator-use:   settle ${quiet - started} ms${answer.settled === false ? " (still changing)" : ""}${answer.changed === false ? " (no change)" : ""}: first change ${answer.first_change_ms} ms, ${answer.reads} read(s) ${readMs} ms, ${answer.dropped} dropped${reads ? `, ${reads} more read(s) ${Date.now() - quiet} ms` : ""}${answer.animating ? `, still animating ${JSON.stringify(answer.animating)}` : ""}\n`);
        if (Array.isArray(answer.read_phases) && (answer.read_phases as string[]).some((p) => /reloaded|\+/.test(p))) process.stderr.write(`simulator-use:   read phases: ${(answer.read_phases as string[]).join(" | ")}\n`);
        if (Array.isArray(answer.region_failures)) process.stderr.write(`simulator-use:   region checks failed: ${(answer.region_failures as string[]).join(" | ")}\n`);
        if (Array.isArray(answer.trace)) process.stderr.write(`simulator-use:   trace (input ${answer.input_ms} ms): ${(answer.trace as number[][]).map(([t, x, y, w, h, area]) => `${t}:${x},${y},${w}x${h}=${area}`).join(" ")}\n`);
      }
      // changed false: the engine watched the screen and nothing on it changed in the time given. animating: small
      // parts of it that were still moving as it was read (a control easing out), each [x, y, width, height].
      const animating = Array.isArray(answer.animating) ? (answer.animating as number[][]).map(([x, y, width, height]) => ({ x: x!, y: y!, width: width!, height: height! })) : undefined;
      return { snap, settled: answer.settled !== false, ...(answer.watched === true ? { changed: answer.changed !== false } : {}), ...(animating?.length ? { animating } : {}) };
    }
    // A foldable's engine refused it: the screen in use changed (a fold). Never sent another way.
    const refused = screenRefusal(answer);
    if (refused) throw refused;
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
    const noWebScan = pagesListedNow(udid);
    const answer = await engineCall(udid, { op: "settle_read", lean: true, first_change_ms: 0, quiet_ms: QUIET_MS, start_ms: READ_START_MS, guard_ms: READ_GUARD_MS, timeout_ms: STILL_READ_MS, ...(noWebScan ? { web: false } : {}) }, STILL_READ_MS + 60_000);
    if (answer?.ok && answer.tree) {
      const tree = await withPages(udid, Array.isArray(answer.tree) ? (answer.tree as AxNode[]) : [answer.tree as AxNode], noWebScan, async () => (await describeWhenReady(udid, {})).tree);
      if (setting("DEBUG")) process.stderr.write(`simulator-use:   read when still: ${answer.waited_ms} ms, ${answer.reads} read(s) ${(answer.read_ms as number[] | undefined)?.join("+") ?? "?"} ms, ${answer.dropped} dropped${answer.settled === false ? " (still changing)" : ""}\n`);
      return snapshot(tree);
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
