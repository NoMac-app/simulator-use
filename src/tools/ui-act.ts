import { setTimeout as sleep } from "node:timers/promises";

import { diff } from "../act/diff.ts";
import { fieldAt, isResolved, resolve, type Resolved } from "../act/resolve.ts";
import { describeTarget, KEYS, parseStep, type Direction, type Step, type Target } from "../act/steps.ts";
import type { Frame } from "../look/snapshot.ts";
import { setPasteboard } from "../engine/apps.ts";
import { batch, elementAt, gesture, pressButton, setSlider, typeStep } from "../engine/axe.ts";
import { ToolError } from "../errors.ts";
import { withLock } from "../engine/lock.ts";
import { listDevices, pickDevice } from "../engine/simctl.ts";
import { heldDevice } from "../engine/state.ts";
import { readScreen, settle } from "../look/read.ts";
import { type AxNode, quote, render, type Element, type Snapshot } from "../look/snapshot.ts";
import type { Tool, ToolResult } from "./types.ts";
import { setting } from "../settings.ts";

const FIELDS = new Set(["textfield", "securefield", "searchfield", "textview"]);
/** Long work never blocks a call past 45 s. */
const BUDGET_MS = 45_000;
/** A target not on screen yet (a screen still appearing) gets this long to show up. */
const FIND_WAIT_MS = 2_000;
/** Typed text reaches the app a moment after the keys do; this is how long the read-back waits for it. */
const READ_BACK_MS = 2_500;
const READ_BACK_MAX_MS = 8_000;
const POLL_MS = 150;
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
 * A finger drag across the content, clear of the navigation and tab bars. Scrolls move slowly (1.2 s) so the
 * content follows the finger, about 0.8 of a screen, without flinging past: measured on a 40-row list, a 0.3 s
 * swipe of the same length scrolled 20 rows, this drag 10. Swipes are quick, for carousels and dismissals.
 */
const sweep = (snap: Snapshot, direction: Direction, slow: boolean) => {
  const { screen } = snap;
  const floor = snap.tabs.length ? Math.min(...snap.tabs.map((t) => t.frame.y)) - 20 : screen.y + screen.height - 60;
  const top = screen.y + screen.height * 0.25;
  const middle = (top + floor) / 2;
  const half = ((floor - top) * 0.75) / 2;
  const cx = screen.x + screen.width / 2;
  const [x1, y1, x2, y2] = {
    up: [cx, middle + half, cx, middle - half],
    down: [cx, middle - half, cx, middle + half],
    left: [screen.x + screen.width * 0.85, middle, screen.x + screen.width * 0.15, middle],
    right: [screen.x + screen.width * 0.15, middle, screen.x + screen.width * 0.85, middle],
  }[direction].map(Math.round) as [number, number, number, number];
  return [slow ? "drag" : "swipe", "--start-x", `${x1}`, "--start-y", `${y1}`, "--end-x", `${x2}`, "--end-y", `${y2}`, "--duration", slow ? "1.2" : "0.3"];
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
  return [slow ? "drag" : "swipe", "--start-x", `${x1}`, "--start-y", `${y1}`, "--end-x", `${x2}`, "--end-y", `${y2}`, "--duration", slow ? "1.2" : "0.3"];
};

/**
 * Key presses for text. AXe types only what a US keyboard has; anything else (é, 日本, emoji, a new line)
 * goes through the Simulator's clipboard and a paste, which iOS takes from a keyboard shortcut without asking.
 */
async function typing(udid: string, text: string, paste = false): Promise<string[]> {
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
  if (bad >= 0) return { text: `Step ${bad + 1} (${lines[bad]!.trim()}): ${steps[bad] as string}\nNothing was done.`, isError: true };

  const firstRead = Date.now();
  let snap = (await readScreen(udid)).snap;
  if (setting("DEBUG")) process.stderr.write(`simulator-use: first read ${Date.now() - firstRead} ms\n`);
  const before = snap;
  const notes: string[] = [];
  // The field typed text goes into: the last field tapped or filled in this call.
  let field: Element | undefined;
  // After typing, the last read may be out of date (an on-screen keyboard can scroll the form), so the next
  // tap first checks the one element under its point (0.15 s) instead of reading the whole screen (0.45 s).
  let stale = false;
  const fresh = async () => {
    snap = (await readScreen(udid, false)).snap;
    stale = false;
    return snap;
  };
  const settled = async (n: number) => {
    const s = await settle(udid, snap.app);
    if (!s.settled) notes.push(`step ${n}: the screen was still changing after 4 s`);
    snap = s.snap;
    stale = false;
  };
  const locate = async (target: Target): Promise<Resolved> => {
    let r = resolve(snap, target);
    if (stale && isResolved(r) && r.element && !pinned(await elementAt(udid, r.x, r.y), r.element)) r = resolve(await fresh(), target);
    const deadline = Date.now() + FIND_WAIT_MS;
    while (!isResolved(r) && !r.ambiguous && Date.now() < deadline) {
      await sleep(250);
      r = resolve(await fresh(), target);
    }
    if (!isResolved(r)) {
      // The usual reason a target is missing: an alert or sheet came up in front of it.
      if (snap.modal && !r.ambiguous) {
        const answers = snap.elements.filter((e) => e.kind === "button" || e.kind === "back").map((e) => quote(e.label ?? e.id ?? "")).slice(0, 4);
        throw new StepFailure(`${r.error.replace(/\.$/, "")}: ${snap.modal === "alert" ? "an alert" : "a sheet or menu"} is in front of the screen.`, answers.length ? `Answer it first: tap ${answers.join(" or ")}.` : "Close it first; ui_look shows it.");
      }
      throw new StepFailure(r.error, r.next);
    }
    return r;
  };
  /** What a field shows now: the one element under its point, or, when that read fails, the field in a full read. */
  const fieldValue = async (at: { x: number; y: number }, element?: Element) => {
    const node = await elementAt(udid, at.x, at.y);
    // The element under the point must be the field: an on-screen keyboard can scroll the form under it.
    if (node && (!element?.id || String(node.AXUniqueId ?? "") === element.id)) return String(node.AXValue ?? "");
    // The single-element read failed on a fresh Xcode 27 VM while the text had landed; a full read is slower but sure.
    const s = await fresh();
    const now = s.elements.find((e) => (element?.id ? e.id === element.id : e.x === at.x && e.y === at.y));
    return now ? (now.value ?? now.label ?? "") : "";
  };
  const readBack = async (at: Resolved, typed: string, kind: string | undefined, check: (shown: string) => boolean) => {
    // Keys reach a just-launched app slowly: a real agent's first fill read "gary@exampl" at 2.5 s and the full
    // address a moment later. While the field keeps changing, keep waiting, up to 8 s in all.
    const started = Date.now();
    let deadline = started + READ_BACK_MS;
    let shown = "";
    do {
      const before = shown;
      shown = await fieldValue(at, at.element);
      if (check(shown)) return shown;
      if (shown !== before) deadline = Math.min(Math.max(deadline, Date.now() + 1_000), started + READ_BACK_MAX_MS);
      await sleep(POLL_MS);
    } while (Date.now() < deadline);
    return shown;
  };

  const run = async (step: Step, n: number) => {
    switch (step.op) {
      case "tap": {
        const r = await locate(step.target);
        const was = render(snap);
        const tapped = Date.now();
        await batch(udid, [tapStep(r)]);
        if (setting("DEBUG")) process.stderr.write(`simulator-use:   tap ${Date.now() - tapped} ms\n`);
        field = r.element && FIELDS.has(r.element.kind) ? r.element : undefined;
        if (field) {
          stale = true;
          return;
        }
        await settled(n);
        // On a fresh Xcode 27 Simulator the first touch-style tap (switches get one) changed nothing, twice in two
        // runs; the second always worked. A switch can be checked, so it gets one more tap only if nothing changed.
        if (render(snap) === was && r.element && (r.element.kind === "switch" || r.element.kind === "checkbox")) {
          await batch(udid, [tapStep(r)]);
          await settled(n);
          if (render(snap) !== was) notes.push(`step ${n}: the ${r.element.kind} needed a second tap`);
        }
        // Some answers come late: iOS's photo permission prompt showed 2 s after the tap. Watch a little longer
        // before saying nothing happened.
        for (let waited = 0; render(snap) === was && waited < LATE_CHANGE_MS; waited += 500) {
          await sleep(500);
          await fresh();
        }
        if (render(snap) === was) {
          // What can't be read (some web views, custom drawing) can't show a tap's effect either.
          const blind = snap.unreadable.some((f) => r.x >= f.x && r.x <= f.x + f.width && r.y >= f.y && r.y <= f.y + f.height);
          notes.push(blind ? `step ${n} (tap ${describeTarget(step.target)}): landed in content that can't be read (some web views, custom drawing); check it with ui_look screenshot` : `step ${n} (tap ${describeTarget(step.target)}): no visible change`);
        }
        return;
      }
      case "fill": {
        const r = await locate(step.target);
        // A point names no element: the field under it says what kind it is (a secure one reads back as dots).
        const kind = r.element?.kind ?? (step.target.by === "point" ? fieldAt(snap.elements, r)?.kind : undefined);
        // Typing at something that isn't a field sends the keys to whichever field still has focus.
        if (kind && !FIELDS.has(kind)) throw new StepFailure(`${describeTarget(step.target)} is a ${kind}, not a text field, so nothing was typed.`, "Fill a textfield, securefield, searchfield or textview from ui_look.");
        // Focus, select all, delete, type: one AXe process, so nothing else lands in between.
        await batch(udid, [`tap -x ${r.x} -y ${r.y}`, "sleep 0.15", "key-combo --modifiers 227 --key 4", `key ${KEYS.delete}`, ...(step.text ? await typing(udid, step.text) : [])]);
        field = r.element;
        stale = true;
        if (!step.text) return;
        let shown = await readBack(r, step.text, kind, (s) => readBackVerdict(kind, s, step.text) === "exact");
        let verdict = readBackVerdict(kind, shown, step.text);
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
        const was = render(snap);
        const slow = step.op === "scroll";
        const direction = slow ? OPPOSITE[step.direction] : step.direction;
        if (step.target) {
          const r = await locate(step.target);
          const f = r.element?.frame ?? { x: r.x - 150, y: r.y - 20, width: 300, height: 40 };
          await gesture(udid, sweepIn(f, direction, slow));
        } else {
          await gesture(udid, sweep(snap, direction, slow));
        }
        await settled(n);
        if (render(snap) === was) notes.push(`step ${n} (${step.op} ${step.direction}): nothing moved${slow && !step.target ? ", so this is the end" : ""}`);
        return;
      }
      case "hold": {
        // A long press: context menus, drag handles, "press and hold to record".
        const r = await locate(step.target);
        const was = render(snap);
        await batch(udid, [`touch -x ${r.x} -y ${r.y} --down --up --delay ${step.seconds}`]);
        await settled(n);
        if (render(snap) === was) notes.push(`step ${n} (hold ${describeTarget(step.target)}): no visible change`);
        return;
      }
      case "set": {
        const r = await locate(step.target);
        if (r.element?.kind !== "slider") throw new StepFailure(`${describeTarget(step.target)} is ${r.element ? `a ${r.element.kind}` : "a point"}, not a slider.`, "set takes a slider from ui_look; a stepper has Increment and Decrement buttons to tap.");
        if (!r.element.id && !r.element.label) throw new StepFailure("This slider has no id or label to set it by.", "Drag it: swipe right on it, or tap along it.");
        // AXe drags the slider and then insists on the exact value; 74.8 for 75 is a set slider, so its verdict is
        // replaced by our own read: within 2 points of the asked percent.
        const by = { id: r.element.id, label: r.element.id ? undefined : r.element.label };
        const reading = () => {
          const now = snap.elements.find((e) => e.kind === "slider" && (r.element!.id ? e.id === r.element!.id : e.label === r.element!.label));
          return { now, reached: now?.value !== undefined ? sliderPercent(now.value) : undefined };
        };
        await setSlider(udid, by, step.percent).catch(() => undefined);
        await settled(n);
        let { now, reached } = reading();
        // AXe's drag missed by 3 to 4 points on an iPad's wide slider. The thumb follows a finger exactly, so drag
        // it from where its value puts it to where the asked value goes, up to twice.
        for (let tries = 0; tries < 2 && now && reached !== undefined && Math.abs(reached - step.percent) > 2; tries++) {
          const f = now.frame;
          const track = Math.max(1, f.width - 2 * SLIDER_THUMB_RADIUS);
          const at = (percent: number) => Math.round(f.x + SLIDER_THUMB_RADIUS + (percent / 100) * track);
          const y = Math.round(f.y + f.height / 2);
          await gesture(udid, ["drag", "--start-x", `${at(reached)}`, "--start-y", `${y}`, "--end-x", `${at(step.percent)}`, "--end-y", `${y}`, "--duration", "0.6"]);
          await settled(n);
          ({ now, reached } = reading());
        }
        if (reached === undefined || Math.abs(reached - step.percent) > 2) {
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
        if (button) await batch(udid, [`tap -x ${button.x} -y ${button.y}`]);
        else await gesture(udid, ["swipe", "--start-x", `${screen.x + 2}`, "--start-y", `${cy}`, "--end-x", `${Math.round(screen.x + screen.width * 0.75)}`, "--end-y", `${cy}`, "--duration", "0.3"]);
        await settled(n);
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
        await batch(udid, [`key ${KEYS[step.key]}`]);
        await settled(n);
        return;
      case "wait":
      case "gone": {
        // Within what is left of the call's 45 s, so two long waits can't run past it.
        const deadline = Math.min(Date.now() + step.seconds * 1000, started + BUDGET_MS - 2_000);
        const met = () => {
          const r = resolve(snap, step.target);
          // Text that matches more than one element is there all the same.
          const present = isResolved(r) || Boolean(r.ambiguous);
          return step.op === "wait" ? present : !present;
        };
        while (!met()) {
          if (Date.now() >= deadline) {
            // What the on-screen keyboard covers is not listed: on a phone without a hardware keyboard (a cloud
            // phone) a label under a field just filled is hidden that way.
            const covered = step.op === "wait" && snap.keyboard ? ` It may be under the keyboard (covering y ${snap.keyboardTop ?? "?"} and below), which is not listed: key return or a tap outside the field hides it.` : "";
            throw new StepFailure(
              `${describeTarget(step.target)} ${step.op === "wait" ? "did not appear" : "was still there"} after ${step.seconds} s.`,
              `The screen is below. Wait longer with ${step.op} ${describeTarget(step.target)} 15, or act on what is there.${covered}`,
            );
          }
          await sleep(250);
          await fresh();
        }
        return;
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() - started > BUDGET_MS) {
      return { text: `Stopped before step ${i + 1}: this call ran past ${BUDGET_MS / 1000} s. ${i} of ${steps.length} steps done.\n${render(snap, { device: deviceLabel })}`, isError: true };
    }
    try {
      const stepStarted = Date.now();
      await run(steps[i] as Step, i + 1);
      if (setting("DEBUG")) process.stderr.write(`simulator-use: step ${i + 1} ${lines[i]!.trim()} ${Date.now() - stepStarted} ms\n`);
    } catch (error) {
      if (!(error instanceof ToolError) && !(error instanceof StepFailure)) throw error;
      const next = error instanceof StepFailure ? error.next : (error.next ?? "Call ui_look to see the screen, then try again.");
      if (!(error instanceof StepFailure)) await fresh().catch(() => snap);
      return {
        text: [`Step ${i + 1} (${lines[i]!.trim()}) failed: ${error.message}`, `Next: ${next}`, `${i} of ${steps.length} steps done before it.`, ...notes, "Screen now:", render(snap, { device: deviceLabel })].join("\n"),
        isError: true,
      };
    }
  }
  if (stale) await fresh();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const changes = diff(before, snap, deviceLabel);
  const quiet = changes === "no visible change" && notes.some((note) => note.endsWith("no visible change") || note.includes("can't be read"));
  return { text: [`${steps.length} step${steps.length === 1 ? "" : "s"} done in ${seconds} s`, ...notes, ...(quiet ? [] : [changes])].join("\n") };
}

export const uiAct: Tool = {
  name: "ui_act",
  title: "Use the screen",
  description:
    'Do steps on the Simulator in order and get back what changed. Steps: tap #id | tap "label" | tap @x,y | fill #id text | type text | scroll down | swipe left ["row"] | hold "label" [seconds] | set #slider 0-100 | back | home | key return | wait "text" [seconds] | gone "text". Text in any language can be typed and is read back; a tap that changes nothing is reported; the first failing step stops the rest.',
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
