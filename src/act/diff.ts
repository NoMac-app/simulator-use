import { line, quote, ref, render, type Element, type Snapshot } from "../look/snapshot.ts";

/**
 * Pairs each element before with itself after: by id, then by kind and label, then a field by its place
 * (a field with no label is named by its text, which is what changed). Ids can appear late: right after a
 * launch the tab buttons had none, a second later they did.
 */
export function pair(before: Element[], after: Element[]): { pairs: [Element, Element][]; added: Element[]; gone: Element[] } {
  const left = new Set(before);
  const right = new Set(after);
  const pairs: [Element, Element][] = [];
  const match = (same: (a: Element, b: Element) => boolean) => {
    for (const b of right) {
      const a = [...left].find((x) => same(x, b));
      if (!a) continue;
      pairs.push([a, b]);
      left.delete(a);
      right.delete(b);
    }
  };
  match((a, b) => Boolean(a.id) && a.id === b.id && a.kind === b.kind);
  match((a, b) => a.kind === b.kind && a.label !== undefined && a.label === b.label);
  match((a, b) => a.kind === b.kind && a.frame.x === b.frame.x && a.frame.y === b.frame.y && a.frame.width === b.frame.width);
  return { pairs, added: [...right], gone: [...left] };
}

/** Short form for a changed element: `#status "Welcome, gary@example.com"`. */
function brief(e: Element): string {
  let out = e.id && e.id !== e.label ? ref(e.id) : e.kind;
  if (e.label !== undefined) out += ` ${quote(e.label)}`;
  if (e.value) out += ` =${quote(e.value)}`;
  if (e.state) out += ` ${e.state}`;
  return out;
}

/**
 * What an action changed, in as few tokens as possible. A new screen (another title or app, or most lines
 * different) comes back whole; otherwise only the changed, new and gone elements, and the keyboard if it moved.
 */
export function diff(before: Snapshot, after: Snapshot, device?: string): string {
  const all = (s: Snapshot) => [...s.elements, ...s.tabs];
  const { pairs, added, gone } = pair(all(before), all(after));
  // What the agent cares about is what an element says; an id showing up late is not a change.
  const says = (e: Element) => `${e.kind}|${e.label ?? ""}|${e.value ?? ""}|${e.state ?? ""}`;
  const edited = pairs.filter(([a, b]) => says(a) !== says(b)).map(([, b]) => b);
  // The same element somewhere else: the content moved (a scroll, a banner pushing rows down).
  const moved = pairs.filter(([a, b]) => says(a) === says(b) && (a.x !== b.x || a.y !== b.y)).map(([, b]) => b);
  const size = all(after).length;
  // An alert or sheet that came up, or went, is a new screen whatever it shares with the one behind it (an alert's
  // Delete was reported as the screen's own Delete "moved", with no word of the alert); so is a part of the screen
  // that became unreadable, or readable.
  const front = before.modal !== after.modal || before.unreadable.length !== after.unreadable.length;
  const newScreen = front || before.app !== after.app || before.title !== after.title || added.length + gone.length > Math.max(4, size / 2) || moved.length > 3;
  if (newScreen) return `screen:\n${render(after, { device })}`;

  const out: string[] = [];
  if (edited.length) out.push(`changed: ${edited.map(brief).join(" · ")}`);
  if (added.length) out.push(`new: ${added.map(line).join(" · ")}`);
  if (gone.length) out.push(`gone: ${gone.map(brief).join(" · ")}`);
  if (moved.length) out.push(`moved: ${moved.map(line).join(" · ")}`);
  if (before.scroll !== after.scroll && after.scroll) out.push(`scroll: ${after.scroll}`);
  if (before.keyboard !== after.keyboard) out.push(after.keyboard ? `keyboard: shown, covering y ${after.keyboardTop ?? "?"} and below` : "keyboard: hidden");
  return out.length ? out.join("\n") : "no visible change";
}
