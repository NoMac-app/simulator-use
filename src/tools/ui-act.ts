import { setTimeout as sleep } from "node:timers/promises";

import { diff } from "../act/diff.ts";
import { fieldAt, isResolved, resolve, type Resolved } from "../act/resolve.ts";
import { DEFAULT_HOLD_SECONDS, DEFAULT_WAIT_SECONDS, describeTarget, KEYS, maskedStep, parseStep, type Direction, type Step, type Target } from "../act/steps.ts";
import type { Frame } from "../look/snapshot.ts";
import { appPids, plainKeyboard, setPasteboard } from "../engine/apps.ts";
import { permissionMode, permissionPrompt } from "../engine/prompts.ts";
import { batch, elementAt, liftFinger, moveFinger, pressButton, setSlider, typeStep } from "../engine/axe.ts";
import { ToolError } from "../errors.ts";
import { withLock } from "../engine/lock.ts";
import { hasEngine } from "../engine/native.ts";
import { listDevices, pickDevice } from "../engine/simctl.ts";
import { currentApp, heldDevice } from "../engine/state.ts";
import { type Input, readScreen, readWhenStill, settle, type SettleOptions } from "../look/read.ts";
import { type AxNode, line, quote, render, type Element, type Snapshot } from "../look/snapshot.ts";
import type { Tool, ToolResult } from "./types.ts";
import { setting } from "../settings.ts";

const FIELDS = new Set(["textfield", "securefield", "searchfield", "textview"]);
/** Long work never blocks a call past 45 s. */
const BUDGET_MS = 45_000;
/** A target not on screen yet (a screen still appearing) gets this long to show up. */
const FIND_WAIT_MS = 2_000;
/**
 * On a screen this call has done nothing to yet, a missing target is waited for only while the screen is changing:
 * still for this long, it is not coming. A missing target cost 2.4 to 3.0 s before (November 22, 2026), and agents
 * answer one with another act two times in three.
 */
const FIND_STILL_MS = 350;
/**
 * After a step of this call, what it started may arrive late with nothing drawn meanwhile: a missing target is given
 * up once the screen has been still this long (something loading that shows it is, a spinner, keeps the full wait).
 */
const FIND_STILL_AFTER_ACT_MS = 1_000;
/** How many scrolls a step makes on its own to reach a target that is just off screen. */
const REACH_SCROLLS = 3;
/** How many scrolls `scroll down until "Row 40"` makes at most. */
const UNTIL_SCROLLS = 20;
/** Typed text reaches the app a moment after the keys do; this is how long the read-back waits for it. */
const READ_BACK_MS = 2_500;
const READ_BACK_MAX_MS = 8_000;
/** A read of the one field under a point takes a few milliseconds with the engine: the text is seen as it lands. */
const POLL_MS = 30;
const AXE_POLL_MS = 150;
/** Half an iOS slider thumb: the track runs this far inside the slider's frame at each end. */
const SLIDER_THUMB_RADIUS = 14;
/** After a tap that seems to change nothing, how long to keep looking before saying so. */
const LATE_CHANGE_MS = 2_500;

class StepFailure extends Error {
  readonly next: string;

  constructor(message: string, next: string) {
    super(message);
    this.next = next;
  }
}

/**
 * Calls on one Simulator run one at a time: in order within this process, and through a lock across simulator-use
 * processes (each CLI call is its own), so two commands' taps never interleave. Two agents should still each
 * have their own Simulator (device_use).
 */
const ACT_LOCK_WAIT_MS = { cli: 60_000, mcp: 25_000 };
const queues = new Map<string, Promise<unknown>>();
function exclusive<T>(udid: string, work: () => Promise<T>): Promise<T> {
  const turn = (queues.get(udid) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(udid, turn.catch(() => undefined));
  return turn;
}

/** Whether the element under a point is the one the last read put there. */
function pinned(node: AxNode | undefined, e: Element): boolean {
  if (!node) return false;
  const id = String(node.AXUniqueId ?? "");
  const label = String(node.AXLabel ?? "").trim();
  if (e.id && id === e.id) return true;
  if (e.label && label && e.label.includes(label)) return true;
  // A field named by its text shows that text as its value.
  return Boolean(e.label) && String(node.AXValue ?? "") === e.label;
}

/** How close to the asked percent a set slider is (74.8 for 75 is set). */
const SLIDER_SET = 2;

/**
 * Sets a slider with a finger held on it, by the engine (false without it: nothing was sent). A slider follows a
 * finger only once the finger has moved about 10 pt, and from then on point for point (measured November 17, 2026,
 * iOS 27.2, EdgeLab's SwiftUI slider on an iPhone 17 Pro Max: a 9 pt drag moved it not at all, 15 pt by 4.6 pt, 25 pt
 * by 14 pt, and long drags ended 1 to 5 points short; AXe 2.0.4's slider command stopped part way there, and our
 * correcting drags of a few points never moved it). So the finger is put on the thumb (where its value puts it) and
 * moved to where the asked value goes, and while it stays down the slider is read and the finger moved again by what
 * it reads short or over, until it reads the value; then the finger is lifted, whatever happened.
 *
 * Any move, the first too, may have put the finger down even when it fails: a busy answer is a move the engine still
 * finishes, a lost or partial one may have gone out in part. So the lift is tried after every move that may have gone
 * out, and an error of its own never hides the move's. It is an up alone (liftFinger), at the last move's end, so
 * where the first move never went out it taps nothing.
 */
export async function holdSlider(udid: string, slider: Element, from: number, to: number): Promise<boolean> {
  const f = slider.frame;
  const track = Math.max(1, f.width - 2 * SLIDER_THUMB_RADIUS);
  const y = Math.round(f.y + f.height / 2);
  // Never off the slider's ends: past them it reads its end value anyway.
  const clamp = (x: number) => Math.round(Math.min(f.x + f.width, Math.max(f.x, x)));
  // Where the finger is, or will be once the move sent last has gone out.
  let x = clamp(f.x + SLIDER_THUMB_RADIUS + (from / 100) * track);
  const readOnce = async () => {
    const node = await elementAt(udid, Math.round(f.x + f.width / 2), y);
    return node?.AXValue !== undefined && node.AXValue !== null ? sliderPercent(String(node.AXValue)) : undefined;
  };
  // The app takes the finger's last moves a moment after they are sent: read until two reads agree (a read right after
  // a move was 1 point behind, and the move made for it went 1 point over).
  const read = async () => {
    let last = await readOnce();
    for (let reads = 0; reads < 20; reads++) {
      await sleep(POLL_MS);
      const now = await readOnce();
      if (now === last) return now;
      last = now;
    }
    return last;
  };
  // A move to `next` from where the finger is: the finger is taken to be there from the moment it is sent.
  const move = (next: number, down: boolean) => {
    const start = x;
    x = next;
    return moveFinger(udid, { x: start, y }, { x: next, y }, { down, up: false });
  };
  let sent = true;
  let failed = false;
  try {
    // false: no engine, and nothing was sent.
    if (!(await move(clamp(x + ((to - from) / 100) * track), true))) {
      sent = false;
      return false;
    }
    // Each move after the first is point for point; one more than the first's shortfall needs is spare.
    for (let moves = 0; moves < 3; moves++) {
      const now = await read();
      if (now === undefined || Math.abs(now - to) <= SLIDER_SET / 4) break;
      const next = clamp(x + ((to - now) / 100) * track);
      if (next === x) break;
      await move(next, false);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (sent) {
      try {
        await liftFinger(udid, { x, y });
      } catch (error) {
        // The move's error says more (the step fails on it either way); the lift's alone is thrown.
        if (!failed) throw error;
      }
    }
  }
  return true;
}

/** A slider's value as a percent: SwiftUI reports 0.75 for a 0...1 slider, others "75%" or 75. */
export function sliderPercent(value: string): number | undefined {
  const n = Number(value.replace(/%$/, ""));
  if (!Number.isFinite(n)) return undefined;
  return value.endsWith("%") || n > 1 ? n : n * 100;
}

/** Letters and digits only, in lower case: "(555) 123-4567" and "5551234567" read the same. */
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Compares what a field shows with what was typed: exactly, the same up to formatting, or not at all. */
export function readBackVerdict(kind: string | undefined, shown: string, typed: string): "exact" | "close" | "wrong" {
  if (kind === "securefield") return /^[•●]+$/.test(shown) && shown.length === [...typed].length ? "exact" : "wrong";
  if (shown === typed) return "exact";
  return loose(shown) === loose(typed) && loose(typed) !== "" ? "close" : "wrong";
}

/**
 * How a scroll's finger moves: 0.3 s, slowing to a stop (the engine's ease), then held still for 0.06 s before it
 * lifts. The content then stops where the finger put it: measured November 22, 2026 on a 40-row list (iOS 27.2), a
 * finger lifted while moving left the list coasting for 1.7 s after a 1.2 s drag (3.5 s a scroll), and by a
 * different distance each time (a scroll down and one up did not come back to the same row); this one takes 1.0 s
 * and comes back to the row it left. AXe's own drag (the fallback) has no ease and no rest, so there it stays the
 * slow drag of before (see gesture in engine/axe.ts).
 */
/** What a bottom bar holds. */
const BAR_KINDS = new Set(["button", "back", "textfield", "searchfield", "popup", "menu"]);
const SCROLL_DRAG = ["--duration", "0.3", "--rest", "0.06", "--steps", "18", "--ease-out"];
const SWIPE = ["--duration", "0.3"];

/**
 * A finger drag across the content, clear of the navigation and tab bars and of the keyboard when it is up (a drag
 * that starts on its keys types). A scroll moves the content by the finger's way, most of what shows, so the last
 * row or two of one screen are the first of the next. Swipes are quick, for carousels and dismissals.
 */
const sweep = (snap: Snapshot, direction: Direction, slow: boolean) => {
  const { screen } = snap;
  // A bar of buttons at the bottom that is not a tab bar (Safari's toolbar, an app's own): a drag that starts or ends
  // on it is the bar's gesture, not the content's (on Safari's, a swipe up opened its tabs).
  const low = snap.elements.filter((e) => BAR_KINDS.has(e.kind) && e.frame.y >= screen.y + screen.height * 0.86 && e.frame.height <= 70);
  const bars = Math.min(snap.tabs.length ? Math.min(...snap.tabs.map((t) => t.frame.y)) - 20 : screen.y + screen.height - 60, low.length >= 2 ? Math.min(...low.map((e) => e.frame.y)) - 14 : Infinity);
  const floor = snap.keyboard && snap.keyboardTop !== undefined ? Math.min(bars, snap.keyboardTop - 12) : bars;
  const top = Math.min(screen.y + screen.height * 0.2, floor - 80);
  const middle = (top + floor) / 2;
  const half = ((floor - top) * (slow ? 0.92 : 0.75)) / 2;
  const cx = screen.x + screen.width / 2;
  const [x1, y1, x2, y2] = {
    up: [cx, middle + half, cx, middle - half],
    down: [cx, middle - half, cx, middle + half],
    left: [screen.x + screen.width * 0.85, middle, screen.x + screen.width * 0.15, middle],
    right: [screen.x + screen.width * 0.15, middle, screen.x + screen.width * 0.85, middle],
  }[direction].map(Math.round) as [number, number, number, number];
  return [slow ? "drag" : "swipe", "--start-x", `${x1}`, "--start-y", `${y1}`, "--end-x", `${x2}`, "--end-y", `${y2}`, ...(slow ? SCROLL_DRAG : SWIPE)];
};

/** A swipe or drag inside one element's box: across a list row to delete it, along a carousel to page it. */
const sweepIn = (f: Frame, direction: Direction, slow: boolean) => {
  const cy = f.y + f.height / 2;
  const cx = f.x + f.width / 2;
  const [x1, y1, x2, y2] = {
    up: [cx, f.y + f.height * 0.85, cx, f.y + f.height * 0.15],
    down: [cx, f.y + f.height * 0.15, cx, f.y + f.height * 0.85],
    left: [f.x + f.width * 0.85, cy, f.x + f.width * 0.15, cy],
    right: [f.x + f.width * 0.15, cy, f.x + f.width * 0.85, cy],
  }[direction].map(Math.round) as [number, number, number, number];
  return [slow ? "drag" : "swipe", "--start-x", `${x1}`, "--start-y", `${y1}`, "--end-x", `${x2}`, "--end-y", `${y2}`, ...(slow ? SCROLL_DRAG : SWIPE)];
};

/**
 * Key presses for text. AXe types only what a US keyboard has; anything else (é, 日本, emoji, a new line)
 * goes through the Simulator's clipboard and a paste, which iOS takes from a keyboard shortcut without asking.
 */
async function typing(udid: string, text: string, paste = false): Promise<string[]> {
  await plainKeyboard(udid);
  // Long text pastes too: typing runs about 55 characters a second, and a call has 45 s.
  if (!paste && text.length <= 200 && /^[\x20-\x7E]*$/.test(text)) return [typeStep(text)];
  await setPasteboard(udid, text);
  return ["key-combo --modifiers 227 --key 25"];
}

/** Switches and checkboxes need a real touch down and up: the Simulator's own tap left an iOS 27 switch as it was. */
const tapStep = (r: Resolved) => `tap -x ${r.x} -y ${r.y}${r.element && (r.element.kind === "switch" || r.element.kind === "checkbox") ? " --tap-style physical" : ""}`;
/** Scrolling down shows what is below, so the finger moves up. */
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };

async function act(udid: string, deviceLabel: string, lines: string[], called: number): Promise<ToolResult> {
  // The budget counts from the call, so time spent queued behind another call on this Simulator is in it.
  const started = called;
  const steps = lines.map(parseStep);
  const bad = steps.findIndex((s) => typeof s === "string");
  if (bad >= 0) return { text: `Step ${bad + 1} (${maskedStep(lines[bad]!)}): ${steps[bad] as string}\nNothing was done.`, isError: true };

  const firstRead = Date.now();
  // The screen as last read, when it has not changed since (the agent looked, then acts): see readScreen.
  const first = await readScreen(udid, true, { reuse: true });
  let snap = first.snap;
  if (setting("DEBUG")) process.stderr.write(`simulator-use: first read ${Date.now() - firstRead} ms${first.reused ? ` (the last read again: ${first.reused})` : first.notReused ? ` (afresh: ${first.notReused})` : ""}\n`);
  const before = snap;
  const notes: string[] = [];
  // The field typed text goes into: the last field tapped or filled in this call.
  let field: Element | undefined;
  // After typing, the last read may be out of date (an on-screen keyboard can scroll the form), so the next
  // tap first checks the one element under its point (0.15 s) instead of reading the whole screen (0.45 s).
  // A read given again is checked the same way before its first tap.
  let stale = Boolean(first.reused);
  const fresh = async () => {
    snap = (await readScreen(udid, false)).snap;
    stale = false;
    return snap;
  };
  /** Sends the input (if any) and waits until the screen holds still, then reads it. */
  const settled = async (n: number, input?: Input, options?: SettleOptions) => {
    const s = await settle(udid, snap.app, input, options);
    const note = `step ${n}: the screen was still changing after ${Math.round((options?.timeoutMs ?? 4_000) / 100) / 10} s`;
    if (!s.settled && !notes.some((x) => x.startsWith(note.replace(/ after .*$/, "")))) notes.push(note);
    snap = s.snap;
    stale = false;
  };
  /** The elements of the screen the last target was found on: which field of its kind it was. */
  let located: Element[] = [];
  /** Whether a step of this call has sent anything to the phone yet. */
  let acted = false;
  /** The step being run, for notes made while a target is found. */
  let current = 0;
  const fail = (r: { error: string; next: string; ambiguous?: boolean }): never => {
    // The usual reason a target is missing: an alert or sheet came up in front of it.
    if (snap.modal && !r.ambiguous) {
      const answers = snap.elements.filter((e) => e.kind === "button" || e.kind === "back").map((e) => quote(e.label ?? e.id ?? "")).slice(0, 4);
      throw new StepFailure(`${r.error.replace(/\.$/, "")}: ${snap.modal === "alert" ? "an alert" : "a sheet or menu"} is in front of the screen.`, answers.length ? `Answer it first: tap ${answers.join(" or ")}.` : "Close it first; ui_look shows it.");
    }
    throw new StepFailure(r.error, r.next);
  };
  /**
   * A point of the element that reaches it. Another element may lie over its middle (a floating search field or bar
   * over a row: iOS 27 Settings' "StandBy" and "Search" had the same point): when the read has another element at
   * the point, the phone says which one a touch there reaches, and a point of the element that reaches it is used,
   * else the step fails and names what covers it.
   */
  const reachable = async (r: Resolved, target: Target): Promise<Resolved> => {
    const e = r.element;
    if (!e || !(await hasEngine(udid))) return r;
    const over = (x: number, y: number) => [...snap.elements, ...snap.tabs].filter((o) => o !== e && x >= o.frame.x && x <= o.frame.x + o.frame.width && y >= o.frame.y && y <= o.frame.y + o.frame.height
      // What holds the element (a cell around its button) is not over it, nor is what it holds.
      && !(o.frame.x <= e.frame.x && o.frame.y <= e.frame.y && o.frame.x + o.frame.width >= e.frame.x + e.frame.width && o.frame.y + o.frame.height >= e.frame.y + e.frame.height)
      && !(e.frame.x <= o.frame.x && e.frame.y <= o.frame.y && e.frame.x + e.frame.width >= o.frame.x + o.frame.width && e.frame.y + e.frame.height >= o.frame.y + o.frame.height));
    const others = over(r.x, r.y);
    if (!others.length) return r;
    if (pinned(await elementAt(udid, r.x, r.y), e)) return r;
    // The part of it on screen, away from its middle: a quarter in from each side.
    const f = e.frame, { screen } = snap;
    const left = Math.max(f.x, screen.x), right = Math.min(f.x + f.width, screen.x + screen.width), top = Math.max(f.y, screen.y), bottom = Math.min(f.y + f.height, screen.y + screen.height);
    const tries = [[0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5], [0.15, 0.2], [0.85, 0.8]].map(([fx, fy]) => ({ x: Math.round(left + (right - left) * fx!), y: Math.round(top + (bottom - top) * fy!) }));
    for (const p of tries) {
      if (over(p.x, p.y).length) continue;
      if (pinned(await elementAt(udid, p.x, p.y), e)) return { element: e, x: p.x, y: p.y };
    }
    const cover = others[0]!;
    throw new StepFailure(`${describeTarget(target)} is covered by ${line(cover)}: a touch on it reaches that instead.`, "Scroll it clear of what covers it (scroll down or scroll up), or close what is over it.");
  };
  const locate = async (target: Target): Promise<Resolved> => {
    let r = resolve(snap, target);
    if (stale && isResolved(r) && r.element && !pinned(await elementAt(udid, r.x, r.y), r.element)) r = resolve(await fresh(), target);
    // An alert or sheet in front, read just now: what is behind it is not coming while it is there.
    if (!isResolved(r) && !r.ambiguous && snap.modal && !stale) fail(r);
    const deadline = Date.now() + FIND_WAIT_MS;
    const watched = await hasEngine(udid);
    const stillMs = acted ? FIND_STILL_AFTER_ACT_MS : FIND_STILL_MS;
    // Since when the screen has been as it is, a control easing out aside (it was read still just now).
    let calmSince = Date.now();
    let reached = 0;
    while (!isResolved(r) && !r.ambiguous && Date.now() < deadline) {
      // Just off screen (a row under a bar, the next rows of a list): scrolled to, a few times at most.
      if (r.scroll && reached < REACH_SCROLLS && !snap.modal) {
        reached++;
        const way = r.scroll;
        await settled(current, { gesture: sweep(snap, OPPOSITE[way], true) });
        acted = true;
        const next = resolve(snap, target);
        if (isResolved(next) && !notes.some((n) => n.startsWith(`step ${current}: scrolled`))) notes.push(`step ${current}: scrolled ${way} to reach ${describeTarget(target)}`);
        r = next;
        continue;
      }
      if (watched) {
        // The engine watches the screen: the target is waited for only while the screen changes. Still for stillMs,
        // or with only a control easing out (a tab bar's glass after a tap on a tab), it is not coming.
        const s = await settle(udid, snap.app, undefined, { firstChangeMs: Math.max(50, stillMs - (Date.now() - calmSince)), timeoutMs: Math.max(500, deadline - Date.now()) });
        snap = s.snap;
        stale = false;
        r = resolve(snap, target);
        if (s.changed === false) break;
        // A control easing out is not the screen changing: the still time runs on through it.
        if (!s.animating) calmSince = Date.now();
        else if (Date.now() - calmSince >= stillMs) break;
      } else {
        await sleep(250);
        r = resolve(await fresh(), target);
      }
    }
    if (!isResolved(r)) return fail(r);
    located = snap.elements;
    return reachable(r, target);
  };
  /**
   * What a field shows now: the one element under its point, or, when that read fails, the field in a full read.
   * A field can move after it was found (an on-screen keyboard scrolls a form, or slides an alert up), so the
   * element under the point counts only when it is that field (its id, or else its size), and a full read finds it
   * by its id, its point, or else as the same one of its kind (the second text field is still the second).
   */
  const fieldValue = async (at: { x: number; y: number }, element?: Element, nth = -1) => {
    const node = await elementAt(udid, at.x, at.y);
    const same = node && (element?.id ? String(node.AXUniqueId ?? "") === element.id
      : !element || !node.frame || (Math.abs(node.frame.width - element.frame.width) <= 2 && Math.abs(node.frame.height - element.frame.height) <= 2));
    if (node && same) return String(node.AXValue ?? "");
    // The single-element read failed on a fresh Xcode 27 VM while the text had landed; a full read is slower but sure.
    const s = await fresh();
    const now = s.elements.find((e) => (element?.id ? e.id === element.id : e.x === at.x && e.y === at.y && (!element || e.kind === element.kind)))
      ?? (element && !element.id && nth >= 0 ? s.elements.filter((e) => e.kind === element.kind)[nth] : undefined);
    // A field's text is its value, or its label when it has no value of its own (an empty value is no text).
    return now ? (now.value || now.label || "") : "";
  };
  const readBack = async (at: Resolved, typed: string, kind: string | undefined, check: (shown: string) => boolean) => {
    // Keys reach a just-launched app slowly: a real agent's first fill read "gary@exampl" at 2.5 s and the full
    // address a moment later. While the field keeps changing, keep waiting, up to 8 s in all.
    const started = Date.now();
    let deadline = started + READ_BACK_MS;
    let shown = "";
    // Every 30 ms with the engine (a point read is a few ms); AXe opens a session per read, so it looks every 150 ms.
    const poll = (await hasEngine(udid)) ? POLL_MS : AXE_POLL_MS;
    do {
      const before = shown;
      shown = await fieldValue(at, at.element, at.element ? located.filter((e) => e.kind === at.element!.kind).indexOf(at.element) : -1);
      if (check(shown)) return shown;
      if (shown !== before) deadline = Math.min(Math.max(deadline, Date.now() + 1_000), started + READ_BACK_MAX_MS);
      await sleep(poll);
    } while (Date.now() < deadline);
    return shown;
  };

  const run = async (step: Step, n: number) => {
    current = n;
    try {
      await runStep(step, n);
    } finally {
      // Every step but a wait or a pause sends something (a failed one may have, too).
      if (step.op !== "wait" && step.op !== "gone" && step.op !== "pause") acted = true;
    }
  };
  /** A label that ends in a number, unquoted (`hold Row 3`): the element of that whole name when the screen has one. */
  const named = (step: { target: Target; whole?: Target }): { target: Target; whole: boolean } => {
    if (step.whole) {
      const r = resolve(snap, step.whole);
      if (isResolved(r) || r.ambiguous || r.scroll) return { target: step.whole, whole: true };
    }
    return { target: step.target, whole: false };
  };
  const runStep = async (step: Step, n: number) => {
    switch (step.op) {
      case "tap": {
        const r = await locate(step.target);
        const was = render(snap);
        if (r.element && FIELDS.has(r.element.kind)) {
          await batch(udid, [tapStep(r)]);
          field = r.element;
          stale = true;
          return;
        }
        field = undefined;
        await settled(n, { steps: [tapStep(r)] });
        // On a fresh Xcode 27 Simulator the first touch-style tap (switches get one) changed nothing, twice in two
        // runs; the second always worked. A switch can be checked, so it gets one more tap only if nothing changed.
        if (render(snap) === was && r.element && (r.element.kind === "switch" || r.element.kind === "checkbox")) {
          await settled(n, { steps: [tapStep(r)] });
          if (render(snap) !== was) notes.push(`step ${n}: the ${r.element.kind} needed a second tap`);
        }
        // Some answers come late: iOS's photo permission prompt showed 2 s after the tap. Watch a little longer
        // before saying nothing happened: until the screen changes from what was last read (and holds still),
        // which the engine sees in the screen's pixels as it happens.
        // Within the window: a screen that never holds still is read as it is at its end, not 4 s later.
        for (const until = Date.now() + LATE_CHANGE_MS; render(snap) === was && Date.now() < until; ) {
          const left = Math.max(1, until - Date.now());
          await settled(n, undefined, { firstChangeMs: left, baseline: "kept", timeoutMs: Math.max(1_000, left) });
        }
        if (render(snap) === was) {
          // What can't be read (some web views, custom drawing) can't show a tap's effect either.
          const blind = snap.unreadable.some((f) => r.x >= f.x && r.x <= f.x + f.width && r.y >= f.y && r.y <= f.y + f.height);
          // A point beside an app's window (an iPhone app on an iPad) reaches what is behind it, not the app.
          const w = snap.screen, outside = snap.window && snap.window !== "unknown" && (r.x < w.x || r.x > w.x + w.width || r.y < w.y || r.y > w.y + w.height);
          notes.push(outside ? `step ${n} (tap ${describeTarget(step.target)}): landed outside the app's window (x ${Math.round(w.x)} to ${Math.round(w.x + w.width)}, y ${Math.round(w.y)} to ${Math.round(w.y + w.height)}), so the app did not get it`
            : blind ? `step ${n} (tap ${describeTarget(step.target)}): landed in content that can't be read (some web views, custom drawing); check it with ui_look screenshot` : `step ${n} (tap ${describeTarget(step.target)}): no visible change`);
        }
        return;
      }
      case "fill": {
        const r = await locate(step.target);
        // A point names no element: the field under it says what kind it is (a secure one reads back as dots).
        const kind = r.element?.kind ?? (step.target.by === "point" ? fieldAt(snap.elements, r)?.kind : undefined);
        // Typing at something that isn't a field sends the keys to whichever field still has focus.
        if (kind && !FIELDS.has(kind)) throw new StepFailure(`${describeTarget(step.target)} is a ${kind}, not a text field, so nothing was typed.`, "Fill a textfield, securefield, searchfield or textview from ui_look.");
        // Focus, select all, delete, type: one AXe process, so nothing else lands in between. A web page's field
        // takes the text as a paste: iOS corrects what is typed into one as it goes ("web" became "Webb", and its
        // suggestion stayed up over the page), and a paste goes in as it is.
        // And it takes its focus late (the page zooms to it, the keyboard comes up): keys sent 0.15 s after the tap
        // were lost on it (a paste that never landed, November 22, 2026), so the tap is let settle first.
        if (r.element?.web) {
          await settled(n, { steps: [`tap -x ${r.x} -y ${r.y}`] });
          await batch(udid, ["key-combo --modifiers 227 --key 4", `key ${KEYS.delete}`, ...(step.text ? await typing(udid, step.text, kind !== "securefield") : [])]);
        } else {
          await batch(udid, [`tap -x ${r.x} -y ${r.y}`, "sleep 0.15", "key-combo --modifiers 227 --key 4", `key ${KEYS.delete}`, ...(step.text ? await typing(udid, step.text) : [])]);
        }
        field = r.element;
        stale = true;
        if (!step.text) return;
        let shown = await readBack(r, step.text, kind, (s) => readBackVerdict(kind, s, step.text) === "exact");
        let verdict = readBackVerdict(kind, shown, step.text);
        if (setting("DEBUG")) process.stderr.write(`simulator-use:   fill: ${r.element?.web ? "pasted (a web page's field)" : "typed"}, read back ${verdict}${verdict === "exact" ? "" : ` (${JSON.stringify(shown.slice(0, 60))})`}\n`);
        // iOS's autocorrect and smart punctuation change typed keys ("--udid" became "—used", ' became ’).
        // A paste is taken as is: try once more that way before calling the text changed or wrong.
        if (verdict !== "exact" && kind !== "securefield") {
          await batch(udid, [`tap -x ${r.x} -y ${r.y}`, "sleep 0.15", "key-combo --modifiers 227 --key 4", `key ${KEYS.delete}`, ...(await typing(udid, step.text, true))]);
          const pasted = await readBack(r, step.text, kind, (s) => readBackVerdict(kind, s, step.text) === "exact");
          const pastedVerdict = readBackVerdict(kind, pasted, step.text);
          if (pastedVerdict === "exact" || (pastedVerdict === "close" && verdict === "wrong")) {
            if (pastedVerdict === "exact") notes.push(`step ${n}: iOS's autocorrect changed the typed keys, so the text was pasted instead`);
            shown = pasted;
            verdict = pastedVerdict;
          }
        }
        if (verdict === "wrong") {
          await fresh();
          throw new StepFailure(
            `${describeTarget(step.target)} shows ${quote(shown)}, not ${kind === "securefield" ? `${[...step.text].length} characters` : quote(step.text)}.`,
            "Check it with ui_look: the field may limit or reformat input, the target may not be a text field, or the keyboard may need a moment.",
          );
        }
        if (verdict === "close") notes.push(`step ${n}: the field reformatted it to ${quote(shown)}`);
        return;
      }
      case "type": {
        await batch(udid, await typing(udid, step.text));
        if (field && field.kind !== "securefield") {
          const at = { x: field.x, y: field.y, element: field };
          const shown = await readBack(at, step.text, field.kind, (s) => loose(s).includes(loose(step.text)));
          if (!loose(shown).includes(loose(step.text))) {
            await fresh();
            throw new StepFailure(`The field shows ${quote(shown)}, without ${quote(step.text)}.`, "Use fill #id text, which focuses the field and checks it.");
          }
        } else if (!field) {
          notes.push(`step ${n}: typed without a known field, so it was not checked; fill #id text checks it`);
        }
        stale = true;
        return;
      }
      case "scroll":
      case "swipe": {
        if (step.op === "scroll" && step.until) {
          // Scroll that way until the target is on screen (it is not tapped), the end of the list, or the call's time.
          const target = step.until;
          const found = () => { const r = resolve(snap, target); return isResolved(r) || Boolean(r.ambiguous); };
          let scrolls = 0;
          while (!found()) {
            if (scrolls >= UNTIL_SCROLLS || Date.now() - started > BUDGET_MS - 6_000) {
              throw new StepFailure(`${describeTarget(target)} did not show after ${scrolls} scroll${scrolls === 1 ? "" : "s"} ${step.direction}.`, `The screen is below. Call it again to go on from here, or look for it another way (a search field, another tab).`);
            }
            const was = render(snap);
            await settled(n, { gesture: sweep(snap, OPPOSITE[step.direction], true) });
            scrolls++;
            if (render(snap) === was) {
              // A list that loads more as its end shows gets a moment to do so, once.
              await settled(n, undefined, { firstChangeMs: 600 });
              if (render(snap) === was && !found()) throw new StepFailure(`${describeTarget(target)} is not ${step.direction === "down" ? "below" : step.direction === "up" ? "above" : `to the ${step.direction}`}: the end was reached after ${scrolls - 1} scroll${scrolls === 2 ? "" : "s"}.`, `The screen is below.${step.direction === "down" ? " scroll up until … looks the other way." : ""}`);
            }
          }
          if (scrolls) notes.push(`step ${n}: ${describeTarget(target)} showed after ${scrolls} scroll${scrolls === 1 ? "" : "s"} ${step.direction}`);
          return;
        }
        const was = render(snap);
        const slow = step.op === "scroll";
        const direction = slow ? OPPOSITE[step.direction] : step.direction;
        if (step.target) {
          const r = await locate(step.target);
          const f = r.element?.frame ?? { x: r.x - 150, y: r.y - 20, width: 300, height: 40 };
          await settled(n, { gesture: sweepIn(f, direction, slow) });
        } else {
          await settled(n, { gesture: sweep(snap, direction, slow) });
        }
        if (render(snap) === was) notes.push(`step ${n} (${step.op} ${step.direction}): nothing moved${slow && !step.target ? ", so this is the end" : ""}`);
        return;
      }
      case "hold": {
        // A long press: context menus, drag handles, "press and hold to record".
        const which = named(step);
        const r = await locate(which.target);
        const was = render(snap);
        const held = which.whole ? DEFAULT_HOLD_SECONDS : step.seconds;
        await settled(n, { steps: [`touch -x ${r.x} -y ${r.y} --down --up --delay ${held}`] });
        if (render(snap) === was) notes.push(`step ${n} (hold ${describeTarget(which.target)}): no visible change`);
        return;
      }
      case "set": {
        const r = await locate(step.target);
        if (r.element?.kind !== "slider") throw new StepFailure(`${describeTarget(step.target)} is ${r.element ? `a ${r.element.kind}` : "a point"}, not a slider.`, "set takes a slider from ui_look; a stepper has Increment and Decrement buttons to tap.");
        if (!r.element.id && !r.element.label) throw new StepFailure("This slider has no id or label to set it by.", "Drag it: swipe right on it, or tap along it.");
        // Within 2 points of the asked percent is a set slider (74.8 for 75).
        const by = { id: r.element.id, label: r.element.id ? undefined : r.element.label };
        const reading = () => {
          const now = snap.elements.find((e) => e.kind === "slider" && (r.element!.id ? e.id === r.element!.id : e.label === r.element!.label));
          return { now, reached: now?.value !== undefined ? sliderPercent(now.value) : undefined };
        };
        let { now, reached } = reading();
        if (!now || reached === undefined || Math.abs(reached - step.percent) > SLIDER_SET) {
          // The engine holds a finger on the slider and reads it as it moves (holdSlider); without the engine, AXe's own
          // slider command drags it, and our read has the last word (AXe insists on the exact value).
          const held = now && reached !== undefined ? await holdSlider(udid, now, reached, step.percent) : false;
          if (!held) await setSlider(udid, by, step.percent).catch(() => undefined);
          await settled(n);
          ({ now, reached } = reading());
        }
        if (reached === undefined || Math.abs(reached - step.percent) > SLIDER_SET) {
          throw new StepFailure(`The slider shows ${quote(now?.value ?? "nothing")}, not ${step.percent}%.`, "Check it with ui_look; a slider with steps only takes some values.");
        }
        return;
      }
      case "back": {
        const was = render(snap);
        // Navigation inside navigation has two back buttons; the inner one (last) goes back one screen.
        const button = [...snap.elements].reverse().find((e) => e.kind === "back");
        const { screen } = snap;
        const cy = Math.round(screen.y + screen.height / 2);
        await settled(n, button ? { steps: [`tap -x ${button.x} -y ${button.y}`] } : { gesture: ["swipe", "--start-x", `${screen.x + 2}`, "--start-y", `${cy}`, "--end-x", `${Math.round(screen.x + screen.width * 0.75)}`, "--end-y", `${cy}`, "--duration", "0.3"] });
        if (render(snap) === was) throw new StepFailure(button ? "The back button changed nothing." : "No back button, and swiping from the left edge changed nothing.", "Call ui_look to find another way back, such as a Close or Cancel button.");
        field = undefined;
        return;
      }
      case "home":
        await pressButton(udid, "home");
        field = undefined;
        await settled(n);
        return;
      case "key":
        await settled(n, { steps: [`key ${KEYS[step.key]}`] });
        return;
      case "pause":
        await sleep(step.seconds * 1000);
        await fresh();
        return;
      case "wait":
      case "gone": {
        // `wait Step 2`, unquoted: "Step 2" when the screen has it (then with the usual time), else "Step" for 2 s; a
        // wait takes either as it comes.
        const which = named(step);
        const target = which.target;
        const waitSeconds = which.whole ? DEFAULT_WAIT_SECONDS : step.seconds;
        // Within what is left of the call's 45 s, so two long waits can't run past it.
        const deadline = Math.min(Date.now() + waitSeconds * 1000, started + BUDGET_MS - 2_000);
        const there = (t: Target) => { const r = resolve(snap, t); return isResolved(r) || Boolean(r.ambiguous); };
        const met = () => {
          // Text that matches more than one element is there all the same.
          const present = there(target) || (step.op === "wait" && step.whole !== undefined && there(step.whole));
          return step.op === "wait" ? present : !present;
        };
        const watching = await hasEngine(udid);
        while (!met()) {
          if (Date.now() >= deadline) {
            // What the on-screen keyboard covers is not listed: on a phone without a hardware keyboard (a cloud
            // phone) a label under a field just filled is hidden that way.
            const covered = step.op === "wait" && snap.keyboard ? ` It may be under the keyboard (covering y ${snap.keyboardTop ?? "?"} and below), which is not listed: key return or a tap outside the field hides it.` : "";
            throw new StepFailure(
              `${describeTarget(target)} ${step.op === "wait" ? "did not appear" : "was still there"} after ${waitSeconds} s.`,
              `The screen is below. Wait longer with ${step.op} ${describeTarget(target)} 15, or act on what is there.${covered}`,
            );
          }
          if (watching) {
            // The engine watches the screen's pixels: a read only once something on it changed (and held still), or
            // after a second of nothing (what changes without a pixel: nothing an agent could see either).
            const s = await settle(udid, snap.app, undefined, { firstChangeMs: Math.max(50, Math.min(1_000, deadline - Date.now())), timeoutMs: Math.max(300, Math.min(2_000, deadline - Date.now())) });
            snap = s.snap;
            stale = false;
          } else {
            await sleep(250);
            await fresh();
          }
        }
        return;
      }
    }
  };

  // The app the tools last launched, when it was run with its permissions granted (app_run's default): iOS's
  // permission prompts that a step brings up are answered as its launch's are, so the next step finds the app.
  const launched = await currentApp(udid);
  const granting = launched && (await permissionMode(udid, launched.bundleId)) === "grant";
  let answered = 0;
  const answerPrompts = async (n: number) => {
    while (granting && answered < 3 && snap.modal === "alert" && snap.app.endsWith(" · system alert")) {
      const prompt = permissionPrompt(snap, snap.app.slice(0, -" · system alert".length));
      const allow = prompt && snap.elements.find((e) => e.kind === "button" && e.label === prompt.allow);
      if (!prompt || !allow) return;
      answered++;
      await settled(n, { steps: [`tap -x ${allow.x} -y ${allow.y}`] });
      notes.push(`step ${n}: answered iOS's prompt ${quote(prompt.title)} (${prompt.allow}); app_run with permissions: "ask" keeps them`);
    }
  };

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() - started > BUDGET_MS) {
      return { text: `Stopped before step ${i + 1}: this call ran past ${BUDGET_MS / 1000} s. ${i} of ${steps.length} steps done.\n${render(snap, { device: deviceLabel })}`, isError: true };
    }
    try {
      const stepStarted = Date.now();
      await run(steps[i] as Step, i + 1);
      if (!stale) await answerPrompts(i + 1);
      if (setting("DEBUG")) process.stderr.write(`simulator-use: step ${i + 1} ${maskedStep(lines[i]!)} ${Date.now() - stepStarted} ms\n`);
    } catch (error) {
      if (!(error instanceof ToolError) && !(error instanceof StepFailure)) throw error;
      const next = error instanceof StepFailure ? error.next : (error.next ?? "Call ui_look to see the screen, then try again.");
      if (!(error instanceof StepFailure)) await fresh().catch(() => snap);
      return {
        text: [`Step ${i + 1} (${maskedStep(lines[i]!)}) failed: ${error.message}`, `Next: ${next}`, `${i} of ${steps.length} steps done before it.`, ...notes, "Screen now:", render(snap, { device: deviceLabel })].join("\n"),
        isError: true,
      };
    }
  }
  // After typing (or a tap on a field): the screen once the text is drawn, which the next call can take as it is.
  if (stale) snap = await readWhenStill(udid);
  // The app went and the Home screen shows: it quit, which after a tap is most often a crash. Said, with where to look.
  if (launched?.executable && before.app !== snap.app && snap.app === "Home screen" && before.app.split(" · ")[0] !== "Home screen" && !(await appPids(udid, launched.executable)).length) {
    notes.push(`${before.app.split(" · ")[0]} is no longer running: it quit or crashed. app_logs {crashes: true} shows a crash's file and line, app_logs its last output.`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const changes = diff(before, snap, deviceLabel);
  const quiet = changes === "no visible change" && notes.some((note) => note.endsWith("no visible change") || note.includes("can't be read"));
  return { text: [`${steps.length} step${steps.length === 1 ? "" : "s"} done in ${seconds} s`, ...notes, ...(quiet ? [] : [changes])].join("\n") };
}

export const uiAct: Tool = {
  name: "ui_act",
  title: "Use the screen",
  description:
    'Do steps on the Simulator in order and get back what changed. Steps: tap #id | tap "label" | tap @x,y | fill #id text | type text | scroll down | scroll down until "label" | swipe left ["row"] | hold "label" [seconds] | set #slider 0-100 | back | home | key return | wait "text" [seconds] | gone "text" | wait 2. Typed text is read back; a tap that changes nothing is reported; the first failing step stops the rest.',
  inputSchema: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "string" }, minItems: 1, description: "One step per item, in the words ui_look prints" },
      device: { type: "string", description: "Name or UDID; default: the one in use" },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  command: "act",
  async run(args, context) {
    const device = pickDevice(await listDevices(), args.device as string | undefined, heldDevice());
    const called = Date.now();
    const label = `${device.name} (${device.runtime})`;
    const busy = (holder: number) => new ToolError(`Another simulator-use call (process ${holder}) is still acting on ${label}.`, "Call ui_act again once it has finished.");
    // An MCP call answers within 45 s of its start, waiting included. A CLI command has no client timing it, so
    // its 45 s start once the Simulator is its own: a command queued behind another is not cut short.
    const cli = context.waitForJobs;
    return exclusive(device.udid, () =>
      withLock(`act-${device.udid}`, cli ? ACT_LOCK_WAIT_MS.cli : ACT_LOCK_WAIT_MS.mcp, busy, () => act(device.udid, label, args.steps as string[], cli ? Date.now() : called)),
    );
  },
};
