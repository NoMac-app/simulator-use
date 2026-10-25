/**
 * The steps ui_act takes, one short line each, in the same words ui_look prints:
 *
 *   tap #signIn            tap "Sign In"           tap button "Sign In"     tap @201,350
 *   fill #email gary@example.com                   type hello
 *   scroll down            swipe left              swipe left "Row 3"       scroll right @201,402
 *   hold "Row 3"           hold #photo 2           set #volume 75           back        home
 *   wait "Welcome"         wait #status 10         gone "Loading"           key return
 */

export type Target =
  | { by: "id"; id: string }
  | { by: "label"; label: string; kind?: string }
  | { by: "point"; x: number; y: number };

export type Direction = "up" | "down" | "left" | "right";

export type Step =
  | { op: "tap"; target: Target }
  | { op: "fill"; target: Target; text: string }
  | { op: "type"; text: string }
  | { op: "scroll"; direction: Direction; target?: Target }
  | { op: "swipe"; direction: Direction; target?: Target }
  | { op: "hold"; target: Target; seconds: number }
  | { op: "set"; target: Target; percent: number }
  | { op: "wait"; target: Target; seconds: number }
  | { op: "gone"; target: Target; seconds: number }
  | { op: "key"; key: keyof typeof KEYS }
  | { op: "back" }
  | { op: "home" };

/** HID keycodes AXe sends. */
export const KEYS = { return: 40, escape: 41, delete: 42, tab: 43, space: 44 } as const;

export const DEFAULT_WAIT_SECONDS = 5;
export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_HOLD_SECONDS = 1;
export const MAX_HOLD_SECONDS = 10;
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** Reads a target from the start of `rest`. Returns it and what follows, or an error message. */
export function parseTarget(rest: string): { target: Target; after: string } | string {
  const s = rest.trimStart();
  const point = /^@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?=\s|$)/.exec(s);
  if (point) return { target: { by: "point", x: Number(point[1]), y: Number(point[2]) }, after: s.slice(point[0].length) };
  if (s.startsWith("#")) {
    if (s[1] === '"') {
      const quoted = readQuoted(s.slice(1));
      if (typeof quoted === "string") return quoted;
      return { target: { by: "id", id: quoted.value }, after: quoted.after };
    }
    const id = /^#(\S+)/.exec(s)?.[1];
    if (!id) return "Expected an id after #.";
    return { target: { by: "id", id }, after: s.slice(id.length + 1) };
  }
  // `button "Sign In"`: a kind, then a quoted label.
  const kinded = /^([a-z]+)\s+(?=")/.exec(s);
  const kind = kinded?.[1];
  const labelPart = kinded ? s.slice(kinded[0].length) : s;
  if (labelPart.startsWith('"')) {
    const quoted = readQuoted(labelPart);
    if (typeof quoted === "string") return quoted;
    return { target: { by: "label", label: quoted.value, ...(kind ? { kind } : {}) }, after: quoted.after };
  }
  const word = /^\S+/.exec(s)?.[0];
  if (!word) return "Expected a target: #id, \"label\" or @x,y.";
  return { target: { by: "label", label: word }, after: s.slice(word.length) };
}

function readQuoted(s: string): { value: string; after: string } | string {
  // A JSON string, so \" and \n work as they do in ui_look's output.
  for (let end = 1; end < s.length; end++) {
    if (s[end] === "\\") {
      end++;
      continue;
    }
    if (s[end] === '"') {
      try {
        return { value: JSON.parse(s.slice(0, end + 1)) as string, after: s.slice(end + 1) };
      } catch {
        return `Bad quoted text: ${s.slice(0, end + 1)}`;
      }
    }
  }
  return `Missing closing quote: ${s}`;
}

/** Text to type: the rest of the line, or a quoted string to keep spaces at its ends. */
function readText(rest: string): string {
  const s = rest.replace(/^\s/, "");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s;
    }
  }
  return s;
}

function seconds(rest: string, fallback = DEFAULT_WAIT_SECONDS, max = MAX_WAIT_SECONDS): number | string {
  const s = rest.trim();
  if (!s) return fallback;
  const n = Number(s.replace(/s$/, ""));
  if (!Number.isFinite(n) || n <= 0) return `Expected seconds, got "${s}".`;
  return Math.min(n, max);
}

/** A target, then an optional number: `wait Welcome back 10`, `hold "Row 3" 2`. An unquoted label may have spaces. */
function targetThenNumber(rest: string): { target: Target; number: string } | string {
  const bare = /^(?![#"@])(.+?)(?:\s+(\d+(?:\.\d+)?)(?:s|%)?)?$/.exec(rest.trim());
  if (bare?.[1]) return { target: { by: "label", label: bare[1] }, number: bare[2] ?? "" };
  const t = parseTarget(rest);
  if (typeof t === "string") return t;
  return { target: t.target, number: t.after.trim().replace(/(s|%)$/, "") };
}

export function parseStep(line: string): Step | string {
  const trimmed = line.trim();
  const [, verb = "", rest = ""] = /^(\S+)\s*([\s\S]*)$/.exec(trimmed) ?? [];
  switch (verb.toLowerCase()) {
    case "tap": {
      const t = parseTarget(rest);
      if (typeof t === "string") return t;
      if (t.after.trim() && t.target.by === "label" && !rest.trimStart().startsWith('"')) return { op: "tap", target: { by: "label", label: rest.trim() } };
      if (t.after.trim()) return `Unexpected "${t.after.trim()}" after the target.`;
      return { op: "tap", target: t.target };
    }
    case "fill": {
      const t = parseTarget(rest);
      if (typeof t === "string") return t;
      if (!t.after.trim()) return "fill needs a target and the text: fill #email gary@example.com";
      return { op: "fill", target: t.target, text: readText(t.after) };
    }
    case "type":
      if (!rest) return "type needs the text: type hello";
      return { op: "type", text: readText(` ${rest}`) };
    case "scroll":
    case "swipe": {
      // `swipe left` sweeps the screen; `swipe left "Row 3"` sweeps that row (to delete it, for example).
      const [, word = "", on = ""] = /^(\S*)\s*([\s\S]*)$/.exec(rest.trim()) ?? [];
      const direction = word.toLowerCase();
      if (!DIRECTIONS.has(direction)) return `${verb} needs a direction: up, down, left or right.`;
      const op = verb.toLowerCase() as "scroll" | "swipe";
      if (!on.trim()) return { op, direction: direction as Direction };
      const t = parseTarget(on.trim().startsWith('"') || on.trim().startsWith("#") || on.trim().startsWith("@") ? on : `"${on.trim()}"`);
      if (typeof t === "string") return t;
      return { op, direction: direction as Direction, target: t.target };
    }
    case "wait":
    case "gone":
    case "hold": {
      const t = targetThenNumber(rest);
      if (typeof t === "string") return t;
      if (verb.toLowerCase() === "hold") {
        const s = seconds(t.number, DEFAULT_HOLD_SECONDS, MAX_HOLD_SECONDS);
        if (typeof s === "string") return s;
        return { op: "hold", target: t.target, seconds: s };
      }
      const s = seconds(t.number);
      if (typeof s === "string") return s;
      return { op: verb.toLowerCase() as "wait" | "gone", target: t.target, seconds: s };
    }
    case "set": {
      const t = targetThenNumber(rest);
      if (typeof t === "string") return t;
      const percent = Number(t.number);
      if (t.number === "" || !Number.isFinite(percent) || percent < 0 || percent > 100) return "set takes a slider and a percent from 0 to 100: set #volume 75";
      return { op: "set", target: t.target, percent };
    }
    case "key": {
      const key = rest.trim().toLowerCase();
      if (!(key in KEYS)) return `key takes one of: ${Object.keys(KEYS).join(", ")}.`;
      return { op: "key", key: key as keyof typeof KEYS };
    }
    case "back":
    case "home":
      if (rest.trim()) return `${verb} takes nothing after it.`;
      return { op: verb.toLowerCase() as "back" | "home" };
    default:
      return `Unknown step "${verb}". Steps: tap, fill, type, scroll, swipe, hold, set, wait, gone, key, back, home.`;
  }
}

export function describeTarget(t: Target): string {
  if (t.by === "id") return `#${t.id}`;
  if (t.by === "point") return `@${t.x},${t.y}`;
  return `${t.kind ? `${t.kind} ` : ""}${JSON.stringify(t.label)}`;
}

/** A step as an answer repeats it: a fill's or type's text left out, since the answer can reach logs and a replay. */
export function maskedStep(line: string): string {
  const trimmed = line.trim();
  const verb = (/^\S+/.exec(trimmed)?.[0] ?? "").toLowerCase();
  if (verb !== "fill" && verb !== "type") return trimmed;
  const step = parseStep(trimmed);
  return typeof step !== "string" && step.op === "fill" ? `fill ${describeTarget(step.target)} …` : `${verb} …`;
}
