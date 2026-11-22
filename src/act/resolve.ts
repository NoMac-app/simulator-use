import { line, type Element, type Snapshot } from "../look/snapshot.ts";
import { describeTarget, type Target } from "./steps.ts";

/** Kinds a person taps, preferred over plain text with the same label. */
const TAPPABLE = new Set(["button", "back", "link", "cell", "tab", "switch", "checkbox", "radio", "textfield", "securefield", "searchfield", "textview", "popup", "menu", "segmented", "picker", "slider", "stepper"]);

/** Words that turn a label into the opposite of the target that follows them: "Don’t Allow" is not "Allow". */
const NEGATED = /(?:^|[^\p{L}\p{N}])(?:don['’]?t|do not|not|never|no)\s+$/iu;

/**
 * Whether a label holds the target as words of its own, not negated: "Allow" is in "Allow While Using App" and
 * "Count: 2, Increment" holds "Increment", but "Don’t Allow" and "Disallow" do not hold "Allow", nor "Item 27" "Item 2" (an agent's
 * "tap Allow" on a prompt whose buttons are "Don’t Allow" and "Continue" tapped Don’t Allow, October 23).
 */
function holds(label: string, want: string): boolean {
  const word = /^[\p{L}\p{N}]/u.test(want);
  // A target that ends in a digit ends a number of the label too: "Item 2" is not in "Item 27".
  const numberEnd = /\p{N}$/u.test(want);
  for (let at = label.indexOf(want); at >= 0; at = label.indexOf(want, at + 1)) {
    const before = label.slice(0, at);
    if ((word && /[\p{L}\p{N}]$/u.test(before)) || NEGATED.test(before)) continue;
    if (numberEnd && /^\p{N}/u.test(label.slice(at + want.length))) continue;
    return true;
  }
  return false;
}

export type Resolved = { element?: Element; x: number; y: number };
export type Unresolved = {
  error: string;
  next: string;
  ambiguous?: boolean;
  /** The target is one of the elements just off screen: scrolling this way shows it. */
  scroll?: "up" | "down" | "left" | "right";
};

/**
 * Finds a target on the screen: by #id exactly; by label exactly (any case), then by a unique partial match (the
 * target as words of the label, not negated);
 * or a point as given. Ties go to tappable elements; a tie that remains is an error listing the candidates.
 */
export function resolve(snap: Snapshot, target: Target): Resolved | Unresolved {
  if (target.by === "point") return { x: Math.round(target.x), y: Math.round(target.y) };
  const all = [...snap.elements, ...snap.tabs];
  let found: Element[];
  if (target.by === "id") {
    found = all.filter((e) => e.id === target.id);
  } else {
    const want = target.label.toLowerCase();
    const ofKind = target.kind ? all.filter((e) => e.kind === target.kind) : all;
    found = ofKind.filter((e) => e.label?.toLowerCase() === want);
    // A long label as ui_look prints it, cut with "…": the label that starts with what was printed.
    if (!found.length && want.endsWith("…") && want.length > 20) found = ofKind.filter((e) => e.label?.toLowerCase().startsWith(want.slice(0, -1)));
    if (!found.length) found = ofKind.filter((e) => (e.label !== undefined && holds(e.label.toLowerCase(), want)) || e.value?.toLowerCase() === want);
  }
  if (found.length > 1) {
    const tappable = found.filter((e) => TAPPABLE.has(e.kind));
    if (tappable.length) found = tappable;
  }
  // One id on several elements (every row of a list): the same point twice is one element, else it's ambiguous.
  if (target.by === "id" && found.length > 1 && found.every((e) => e.x === found[0]!.x && e.y === found[0]!.y)) found = [found[0]!];
  if (found.length === 1) {
    const element = found[0]!;
    return { element, x: element.x, y: element.y };
  }
  if (found.length > 1) {
    return {
      error: `${found.length} elements match ${describeTarget(target)}: ${found.slice(0, 5).map(line).join(" · ")}`,
      next: "Use a #id, a quoted exact label, kind plus label (button \"Save\"), or @x,y.",
      ambiguous: true,
    };
  }
  // An element just off screen (a row under a bar, the next rows of a list): which way it is.
  const want = target.by === "label" ? target.label.toLowerCase() : "";
  const off = (snap.offscreen ?? []).find((e) => (target.by === "id" ? e.id === target.id : e.label !== undefined && (e.label.toLowerCase() === want || holds(e.label.toLowerCase(), want))));
  if (off) {
    const scroll = ({ above: "up", below: "down", left: "left", right: "right" } as const)[off.where];
    return { error: `${describeTarget(target)} is off screen, ${off.where === "above" || off.where === "below" ? off.where : `to the ${off.where}`}.`, next: `scroll ${scroll}, then try again.`, scroll };
  }
  // Which way more elements are, both ways named when there are both: where the target is, if anywhere, is not known.
  const { above, below } = snap.hidden;
  const ways = [above ? `${above} more above (scroll up)` : "", below ? `${below} more below (scroll down)` : ""].filter(Boolean);
  // Which way there is more of the screen: down from its top, up from its bottom, either way from between.
  const atTop = !snap.scroll || / at top$/.test(snap.scroll), atBottom = Boolean(snap.scroll && / at bottom$/.test(snap.scroll));
  const until = atBottom ? ` scroll up until ${describeTarget(target)} looks for it up the list.`
    : atTop ? ` scroll down until ${describeTarget(target)} looks for it down the list.`
    : ` scroll down until ${describeTarget(target)} (or scroll up until) looks for it.`;
  return {
    error: `No ${describeTarget(target)} on screen.`,
    next: ways.length || snap.scroll ? `${ways.length ? `${ways.join(", ")}.` : "The screen scrolls."}${until} Or call ui_look.` : "Call ui_look to see what is on screen.",
  };
}

export const isResolved = (r: Resolved | Unresolved): r is Resolved => !("error" in r);

const TEXT_FIELDS = new Set(["textfield", "securefield", "searchfield", "textview"]);

/**
 * The text field under a point, the smallest when fields nest: what `fill @x,y` aims at, so its kind is known
 * (a secure field reads back as dots) even when the step named a point, not the field.
 */
export function fieldAt(elements: readonly Element[], point: { x: number; y: number }): Element | undefined {
  const holding = elements.filter(
    (e) => TEXT_FIELDS.has(e.kind) && point.x >= e.frame.x && point.x <= e.frame.x + e.frame.width && point.y >= e.frame.y && point.y <= e.frame.y + e.frame.height,
  );
  return holding.sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
}
