/**
 * Turns the Simulator's accessibility tree (AXe describe-ui JSON) into the compact screen an agent reads:
 * one line per element with its kind, label, #id, state and @x,y center in points. Groups, decorations,
 * scroll bars and the on-screen keyboard's keys are folded away; the tab bar and scrolling become one line each.
 *
 * Only what can be tapped is listed: a sheet, a full-screen cover or an alert hides the screen behind it,
 * and content under the navigation bar, the tab bar or the keyboard is counted as hidden instead.
 */

export type Frame = { x: number; y: number; width: number; height: number };

export type AxNode = {
  role?: string;
  subrole?: string | null;
  role_description?: string | null;
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | number | null;
  enabled?: boolean;
  frame?: Frame;
  children?: AxNode[];
  /** "point_scan": read from a web page by the engine's web scan (native/engine), not from the app's own tree. */
  found_by?: string;
  /**
   * On the app's root, from the engine: the app runs in a window (an iPhone app on an iPad), placed at x, y on the
   * screen and drawn scale times its size, its frames already moved there; "unknown" when the window could not be
   * measured, its frames then the app's own.
   */
  placement?: { x: number; y: number; scale: number } | "unknown";
  /** On the app's root, beside placement: the whole screen in points (the app's root is its window). */
  display?: { width: number; height: number };
};

/** One element the agent can see, with the point to tap it. */
export type Element = {
  kind: string;
  label?: string;
  id?: string;
  value?: string;
  state?: string;
  x: number;
  y: number;
  frame: Frame;
};

export type Snapshot = {
  app: string;
  title?: string;
  elements: Element[];
  tabs: Element[];
  keyboard: boolean;
  /** Where an on-screen keyboard starts; nothing below it is listed. */
  keyboardTop?: number;
  scroll?: string;
  /** Elements that exist but are off screen, or under a bar or the keyboard. */
  hidden: { above: number; below: number; left: number; right: number };
  /** Large areas with nothing readable inside: web views, maps, games, custom drawing. */
  unreadable: Frame[];
  /** A sheet, cover or alert in front: what is listed is only what it shows. */
  modal?: "alert" | "screen";
  /** The app's area: the whole screen, or its window. */
  screen: Frame;
  /** An app in a window (an iPhone app on an iPad): how much it is scaled, or "unknown" when its place was not found. */
  window?: { scale: number } | "unknown";
  /** The whole screen in points, when the app is in a window (screen is then the window). */
  display?: { width: number; height: number };
};

/** UIKit's keyboard, its suggestion bar and the view holding both: shown to the agent as one line. */
const KEYBOARD_IDS = new Set(["inputView", "UIKeyboardLayoutStar Preview", "SystemInputAssistantView"]);
const STATUS_BAR_BOTTOM = 50;
const SCROLL_BAR = /^(Vertical|Horizontal) scroll bar, (\d+) pages?$/;
const CONTROLS = new Set(["button", "back", "tab", "segment", "link", "cell", "switch", "checkbox", "radio", "slider", "stepper", "popup", "menu", "picker", "textfield", "securefield", "searchfield", "textview"]);
const FIELDS = new Set(["textfield", "securefield", "searchfield", "textview"]);
/** Kinds whose words can be in their value alone: a web page's text, headings and links (read from its own process). */
const VALUE_NAMED = new Set(["text", "heading", "link"]);
/** A static text's words: its label, or a web page's, which come as its value. */
const wordsOf = (n: AxNode) => text(n.AXLabel) || (n.role === "AXStaticText" || n.role === "AXHeading" || n.role === "AXLink" ? text(n.AXValue) : "");
/** UIKit names a navigation bar after its view controller's class when it has no title. */
const MANGLED = /^_Tt|^[A-Za-z0-9]+(Controller|Hosting)$/;
const ROLE_KINDS: Record<string, string> = {
  AXButton: "button",
  AXLink: "link",
  AXCell: "cell",
  AXStaticText: "text",
  AXHeading: "heading",
  AXImage: "image",
  AXTextField: "textfield",
  AXSearchField: "searchfield",
  AXTextView: "textview",
  AXTextArea: "textview",
  AXSlider: "slider",
  AXIncrementor: "stepper",
  AXPopUpButton: "popup",
  AXMenuButton: "menu",
  AXPicker: "picker",
  AXPickerWheel: "picker",
  AXProgressIndicator: "progress",
  AXRadioButton: "radio",
  AXCheckBox: "checkbox",
  AXSheet: "alert",
  AXGenericElement: "element",
};
/** Roles that only hold other elements. */
const CONTAINERS = new Set(["", "AXGroup", "AXApplication", "AXScrollArea", "AXWindow", "AXTabGroup", "AXSegmentedControl"]);

function kindOf(node: AxNode, inTabGroup: boolean): string | null {
  const role = node.role ?? "";
  if (role === "AXButton" && node.role_description === "back button") return "back";
  if (role === "AXTextField" && node.subrole === "AXSecureTextField") return "securefield";
  // A web page's checkbox comes as a switch too (WebKit on iOS): call it what the page has.
  if (role === "AXCheckBox" && node.subrole === "AXSwitch") return node.found_by === "point_scan" ? "checkbox" : "switch";
  // A tab button inside a tab group is a segment of a segmented control; any other is a tab: in the iPhone's
  // tab bar, or in the iPad's, which sits at the top with no "Tab Bar" group around it.
  if (role === "AXRadioButton" && node.subrole === "AXTabButton") return inTabGroup ? "segment" : "tab";
  if (ROLE_KINDS[role]) return ROLE_KINDS[role];
  if (CONTAINERS.has(role)) return null;
  // Anything else with a name still matters (maps, web links): name it after its role.
  return (node.role_description || role.replace(/^AX/, "")).toLowerCase().replace(/\s+/g, "");
}

const text = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value).trim());
const center = (f: Frame) => ({ x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) });
const inside = (point: { x: number; y: number }, f: Frame) => point.x >= f.x && point.x < f.x + f.width && point.y >= f.y && point.y < f.y + f.height;
const area = (f: Frame) => Math.max(0, f.width) * Math.max(0, f.height);
const isTabBar = (n: AxNode) => n.AXLabel === "Tab Bar" || n.role_description === "tab bar";
const isNavBar = (n: AxNode) => n.role_description?.toLowerCase() === "nav bar";

/** The part of a frame on screen, below the navigation bar and above the tab bar, or null when none of it is. */
function visible(f: Frame, screen: Frame, floor: number, ceiling = screen.y): Frame | null {
  const x = Math.max(f.x, screen.x);
  const y = Math.max(f.y, ceiling);
  const right = Math.min(f.x + f.width, screen.x + screen.width);
  const bottom = Math.min(f.y + f.height, floor);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function* walkAll(nodes: AxNode[]): Generator<AxNode> {
  for (const n of nodes) {
    yield n;
    yield* walkAll(n.children ?? []);
  }
}

function isKeyboard(node: AxNode): boolean {
  if (node.AXUniqueId && KEYBOARD_IDS.has(node.AXUniqueId)) return true;
  // Other layouts: a group holding a row of single-character keys.
  const keys = (node.children ?? []).filter((c) => c.role === "AXButton" && text(c.AXLabel).length === 1).length;
  return keys >= 8;
}

/** Whether a subtree holds anything an agent could read: a labeled element that isn't a scroll bar or the keyboard. */
function readable(node: AxNode): boolean {
  if (isKeyboard(node)) return false;
  const label = wordsOf(node);
  if (!CONTAINERS.has(node.role ?? "") && (label || text(node.AXUniqueId)) && !SCROLL_BAR.test(label)) return true;
  return (node.children ?? []).some(readable);
}

/** Whether a node itself (not its children) has something to read. */
function readableOwn(n: AxNode): boolean {
  const label = wordsOf(n);
  return !CONTAINERS.has(n.role ?? "") && Boolean(label || text(n.AXUniqueId)) && !SCROLL_BAR.test(label) && !isKeyboard(n);
}

/**
 * The box a presented layer occupies: down through the containers with one readable child, to the last one
 * that still holds everything readable. A sheet's is its card (from y 62 on an iPhone), a cover's the screen.
 */
function box(node: AxNode): Frame | undefined {
  let at = node;
  let frame = node.frame;
  for (;;) {
    const inner = (at.children ?? []).filter(readable);
    if (inner.length !== 1 || !CONTAINERS.has(inner[0]!.role ?? "")) return frame;
    at = inner[0]!;
    if (at.frame && area(at.frame) > 0) frame = at.frame;
  }
}

/** The box around what a part shows (its readable elements): a part's own frame can be the whole screen when its content is not. */
function contentBox(node: AxNode): Frame | undefined {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const n of walkAll([node])) {
    if (!n.frame || !area(n.frame) || !readableOwn(n)) continue;
    left = Math.min(left, n.frame.x); top = Math.min(top, n.frame.y);
    right = Math.max(right, n.frame.x + n.frame.width); bottom = Math.max(bottom, n.frame.y + n.frame.height);
  }
  return left === Infinity ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}
/** Whether what one part shows lies over what another shows: a quarter of the smaller of the two, or more. */
function covers(front: AxNode, back: AxNode): boolean {
  const a = contentBox(front), b = contentBox(back);
  if (!a || !b) return true;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 && width * height >= 0.25 * Math.min(area(a), area(b));
}

/**
 * What is in front. An alert (an AXSheet: the app's own, or iOS's permission prompts) always is. Otherwise a
 * presented sheet or full-screen cover is a later sibling of the screen it covers, near the top of the tree:
 * at the first place the tree splits into readable parts, a later part that covers most of the screen and has
 * something to tap or a navigation bar is in front. A later part that is small (a tab bar, a toast) is not.
 */
function frontLayer(roots: AxNode[], screen: Frame): { nodes: AxNode[]; modal?: "alert" | "screen" } {
  let alert: AxNode | undefined;
  for (const n of walkAll(roots)) if (n.role === "AXSheet" && readable(n)) alert = n;
  if (alert) return { nodes: [alert], modal: "alert" };
  let level = roots;
  for (let depth = 0; depth < 40; depth++) {
    const parts = level.filter(readable);
    if (parts.length >= 2) {
      for (let i = parts.length - 1; i > 0; i--) {
        const part = parts[i]!;
        const frame = box(part);
        const large = frame && area(frame) >= area(screen) * 0.5;
        const actionable = [...walkAll([part])].some((n) => isNavBar(n) || CONTROLS.has(kindOf(n, false) ?? ""));
        // Something must be behind it: on an iPad the tab bar is its own part before the screen, and a screen
        // after a part that only holds tabs is just the screen. What it covers is a screen too: iOS 27's large
        // title is its own small part before the list, and a list after a title strip is just the screen.
        // And it must cover what is behind it: an iPad's split view (Settings' sidebar beside its pages) is two
        // parts side by side, the later one's frame the whole screen while what it shows is only on its side.
        const behind = parts
          .slice(0, i)
          .some((p) => (area(box(p) ?? { x: 0, y: 0, width: 0, height: 0 }) >= area(screen) * 0.3) && [...walkAll([p])].some((n) => readableOwn(n) && n.subrole !== "AXTabButton" && !isTabBar(n))
            && covers(part, p));
        if (large && actionable && behind && ![...walkAll([part])].some(isTabBar)) return { nodes: [part], modal: "screen" };
      }
      return { nodes: roots };
    }
    if (parts.length === 0) return { nodes: roots };
    level = parts[0]!.children ?? [];
  }
  return { nodes: roots };
}

/**
 * The on-screen keyboard's frame, or undefined when there is none or it is off screen (a hardware keyboard). For
 * an app in a window (an iPhone app on an iPad), its own inputView is only where the app thinks the keyboard is:
 * the iPad's keyboard, across the bottom of the screen, is the one that covers anything.
 */
function keyboardFrame(nodes: AxNode[], screen: Frame, windowed = false): Frame | undefined {
  let found: Frame | undefined;
  const keyboards = [...walkAll(nodes)].filter((n) => isKeyboard(n) && n.frame);
  const real = windowed && keyboards.some((n) => n.AXUniqueId !== "inputView") ? keyboards.filter((n) => n.AXUniqueId !== "inputView") : keyboards;
  for (const n of real) {
    if (!n.frame) continue;
    const part = visible(n.frame, screen, screen.y + screen.height);
    if (part && (!found || part.y < found.y)) found = { ...part, height: screen.y + screen.height - part.y };
  }
  return found;
}

/** A switch row's unnamed twin is its knob: tapping the row's middle doesn't toggle it, tapping the knob does. */
function knob(owner: Element, point: { x: number; y: number }): true {
  if (owner.kind === "switch") {
    owner.x = point.x;
    owner.y = point.y;
  }
  return true;
}

function stateOf(kind: string, node: AxNode): string | undefined {
  const value = text(node.AXValue);
  const parts: string[] = [];
  if (kind === "switch" || kind === "checkbox") parts.push(value === "1" ? "on" : "off");
  if ((kind === "tab" || kind === "segment" || kind === "radio") && value === "1") parts.push("selected");
  if (node.enabled === false) parts.push("disabled");
  return parts.length ? parts.join(" ") : undefined;
}

/** A slider's 0.30000001192092896 reads as 0.3. */
function tidy(value: string): string {
  return /^-?\d+\.\d{4,}$/.test(value) ? String(Number(Number(value).toFixed(2))) : value;
}

/** The app's name; SpringBoard (the home screen, and iOS's own alerts over an app) has none. */
function appName(app: AxNode, roots: AxNode[], modal?: string): string {
  const own = text(app.AXLabel);
  if (own) return own;
  // SpringBoard's tree with an app's card in it: iOS is showing something over that app. A permission prompt
  // is an alert; the contacts or photos pickers that follow are drawn by other processes and can't be read.
  const card = [...walkAll(roots)].find((n) => text(n.AXUniqueId).startsWith("card:"));
  const name = card ? text(card.AXLabel) : "";
  if (modal === "alert") return name ? `${name} · system alert` : "System alert";
  return name ? `${name} · system screen` : "Home screen";
}

export function snapshot(tree: AxNode | AxNode[]): Snapshot {
  const roots = Array.isArray(tree) ? tree : [tree];
  const app = roots.find((n) => n.role === "AXApplication") ?? roots[0] ?? {};
  const screen = app.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  const front = frontLayer(roots, screen);
  const result: Snapshot = {
    app: appName(app, roots, front.modal),
    elements: [],
    tabs: [],
    keyboard: false,
    hidden: { above: 0, below: 0, left: 0, right: 0 },
    unreadable: [],
    screen,
    ...(front.modal ? { modal: front.modal } : {}),
    ...(app.placement === "unknown" ? { window: "unknown" as const } : app.placement ? { window: { scale: app.placement.scale } } : {}),
    ...(app.display ? { display: app.display } : {}),
  };
  const nodes = front.nodes;

  // Content scrolls under the navigation bar and the tab bar: a tap there hits the bar, not the content.
  // With navigation inside navigation (UIKit in SwiftUI), the innermost bar is the lowest.
  const all = [...walkAll(nodes)];
  const tabBar = all.find(isTabBar)?.frame;
  const navBars = all.filter((n) => isNavBar(n) && n.frame && n.frame.y < screen.y + screen.height / 3);
  const navBar = navBars.reduce<AxNode | undefined>((low, n) => (!low || n.frame!.y + n.frame!.height > low.frame!.y + low.frame!.height ? n : low), undefined);
  const barFrames = new Set([tabBar, ...navBars.map((n) => n.frame)].filter(Boolean));
  // The title: the heading in the innermost navigation bar, or its name when that is a real title.
  const navTitle = navBar && (navBar.children ?? []).find((c) => c.role === "AXHeading" && text(c.AXLabel));
  const navName = text(navBar?.AXUniqueId);
  if (navTitle) result.title = text(navTitle.AXLabel);
  else if (navName && !MANGLED.test(navName)) result.title = navName;

  // An on-screen keyboard covers the bottom of the screen, tab bar included; its own bottom row (Emoji,
  // Dictate) sits outside its groups on iOS 27, so everything whose middle is under it is left out.
  const keyboard = keyboardFrame(roots, screen, Boolean(app.placement));
  result.keyboard = Boolean(keyboard);
  if (keyboard) result.keyboardTop = Math.round(keyboard.y);
  const bottom = keyboard ? keyboard.y : screen.y + screen.height;
  const floor = tabBar ? Math.min(tabBar.y, bottom) : bottom;
  const ceiling = navBar?.frame ? navBar.frame.y + navBar.frame.height : screen.y;

  // The main scroller: the tallest vertical scroll bar. Carousels and an alert's own scrolling are not it.
  let mainScroll: { pages: number; at: string; height: number } | undefined;
  for (const n of all) {
    const m = SCROLL_BAR.exec(text(n.AXLabel));
    if (!m || m[1] !== "Vertical" || !n.frame || n.frame.height < screen.height * 0.4) continue;
    if (!mainScroll || n.frame.height > mainScroll.height) mainScroll = { pages: Number(m[2]), at: text(n.AXValue), height: n.frame.height };
  }
  // An alert's own scrolling text is not the screen's.
  if (mainScroll && mainScroll.pages > 1 && front.modal !== "alert") result.scroll = `${mainScroll.pages} pages, at ${mainScroll.at === "0%" ? "top" : mainScroll.at === "100%" ? "bottom" : mainScroll.at}`;

  const hide = (f: Frame) => {
    const c = center(f);
    if (c.x < screen.x) result.hidden.left++;
    else if (c.x > screen.x + screen.width) result.hidden.right++;
    else if (c.y < (ceiling + floor) / 2) result.hidden.above++;
    else result.hidden.below++;
  };

  const listed = new Set<string>();
  const walk = (node: AxNode, owner: Element | null, inBar: boolean, inTabGroup: boolean, parentLabel: string) => {
    if (isKeyboard(node)) return;
    const nowInBar = inBar || barFrames.has(node.frame);
    const kind = kindOf(node, inTabGroup);
    const label = text(node.AXLabel);
    const id = text(node.AXUniqueId);

    if (SCROLL_BAR.test(label)) return;
    // A large area with nothing readable inside: a web view, a map, a game, custom drawing.
    if ((node.role === "AXScrollArea" || node.role === "AXWebArea") && node.frame && area(node.frame) >= area(screen) * 0.15 && !readable(node)) {
      const shown = visible(node.frame, screen, floor, ceiling);
      if (shown) result.unreadable.push(shown);
      return;
    }

    let element: Element | null = null;
    // A zero-size node is a container (a home screen page, a folder) whose children have their own frames.
    const sized = node.frame && node.frame.width > 0 && node.frame.height > 0;
    if (kind && node.frame && sized) {
      // Bars' own buttons, and tabs (an iPad's float over the navigation bar), are never under a bar.
      const onBar = nowInBar || kind === "tab";
      const shown = onBar ? visible(node.frame, screen, bottom) : visible(node.frame, screen, floor, ceiling);
      const point = shown ? center(shown) : null;
      if (keyboard && shown && inside(center(node.frame), keyboard) && node.children?.length) {
        // A container whose middle is under the keyboard (an alert taller than the room above it) keeps what of it
        // is above: each child is judged on its own.
        for (const child of node.children) walk(child, owner, nowInBar, node.role === "AXTabGroup", label || parentLabel);
        return;
      }
      if (keyboard && (!shown || inside(center(node.frame), keyboard))) return;
      const covered = point && !onBar && tabBar && inside(point, tabBar);
      if (!shown || covered) {
        if (label || id) hide(node.frame);
        return;
      }
      let value = tidy(text(node.AXValue));
      if (kind === "switch" || kind === "checkbox" || kind === "tab" || kind === "segment" || kind === "radio") value = "";
      // A field with no label shows its placeholder or its text as the value; name it by that.
      const name = label || (FIELDS.has(kind) || VALUE_NAMED.has(kind) ? value : "");
      if (name === value) value = "";
      const skip =
        // The title is in the header line.
        (kind === "heading" && name === result.title) ||
        (kind === "image" && (!label || owner !== null)) ||
        // Inside a control: its own text and icons repeat its label; an unnamed twin (a switch's knob) adds nothing.
        (owner !== null && !CONTROLS.has(kind) && (!name || Boolean(owner.label?.includes(name)))) ||
        (owner !== null && kind === owner.kind && !name && knob(owner, point!)) ||
        // A control nested in its twin (an iPad tab inside a tab of the same name) is the same control.
        (owner !== null && kind === owner.kind && name === owner.label) ||
        // An alert's title repeats as its first text.
        (kind === "text" && name === parentLabel) ||
        // UIKit's disclosure arrow in a table cell is a disabled button named "chevron".
        (kind === "button" && node.enabled === false && /^chevron/.test(name)) ||
        (!name && !id && !CONTROLS.has(kind)) ||
        // The status bar (time, signal, battery) only appears in SpringBoard's tree; it is noise there.
        (owner === null && (kind === "text" || kind === "element") && node.frame.y + node.frame.height <= STATUS_BAR_BOTTOM);
      if (!skip) {
        element = { kind, x: point!.x, y: point!.y, frame: node.frame };
        if (name) element.label = name;
        if (id) element.id = id;
        if (value) element.value = value;
        const state = stateOf(kind, node);
        if (state) element.state = state;
        // The same element twice (iPad Settings' pages are in its tree twice, in two orders) is listed once.
        if (kind === "tab") result.tabs.push(element);
        else if (!listed.has(line(element))) {
          listed.add(line(element));
          result.elements.push(element);
        }
      }
    }
    const nextOwner = element && CONTROLS.has(element.kind) ? element : owner;
    for (const child of node.children ?? []) walk(child, nextOwner, nowInBar, node.role === "AXTabGroup", label || parentLabel);
  };
  nodes.forEach((root) => walk(root, null, false, false, ""));
  // A text that is only punctuation ("|" and "(" between a web page's links) says nothing; after the letter runs
  // are joined, so an apostrophe inside an animated word stays.
  const says = (e: Element) => !(e.kind === "text" && !e.id && e.label && !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(e.label));
  result.elements = withoutLetterRuns(withoutRepeatedLabels(result.elements)).filter(says);
  return result;
}

/**
 * Text animated letter by letter is one element per character ("E", "v", "e", ...): a run of four or more
 * one-character texts on one line becomes one line, or goes when another element already says the phrase.
 */
function withoutLetterRuns(elements: Element[]): Element[] {
  const out: Element[] = [];
  const letter = (e: Element | undefined) => e?.kind === "text" && e.label !== undefined && [...e.label].length <= 2 && !e.id;
  for (let i = 0; i < elements.length; ) {
    let j = i;
    while (letter(elements[j]) && Math.abs(elements[j]!.y - elements[i]!.y) <= 4) j++;
    if (j - i < 4) {
      out.push(elements[i]!);
      i++;
      continue;
    }
    const run = elements.slice(i, j);
    const word = run.map((e) => e.label).join("");
    const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    if (!elements.some((e) => e.label && !letter(e) && squash(e.label) === squash(word))) {
      const left = Math.min(...run.map((e) => e.frame.x));
      const right = Math.max(...run.map((e) => e.frame.x + e.frame.width));
      const top = Math.min(...run.map((e) => e.frame.y));
      const frame = { x: left, y: top, width: right - left, height: Math.max(...run.map((e) => e.frame.height)) };
      out.push({ kind: "text", label: word, x: Math.round(left + frame.width / 2), y: run[0]!.y, frame });
    }
    i = j;
  }
  return out;
}

/**
 * A text beside a control that says the same thing ("Count: 2" next to its stepper, "Flavor" next to the
 * "Flavor, Vanilla" picker, "Date" next to its date picker) is the control's own label: one line is enough.
 */
function withoutRepeatedLabels(elements: Element[]): Element[] {
  const controls = elements.filter((e) => CONTROLS.has(e.kind) && e.label);
  return elements.filter((e) => {
    // Plain text, and the unnamed-role elements a picker leaves after its menu closes.
    if ((e.kind !== "text" && e.kind !== "element") || !e.label) return true;
    const t = e.label;
    return !controls.some((c) => Math.abs(c.y - e.y) <= 12 && (c.label === t || c.label!.startsWith(`${t},`) || c.label!.startsWith(`${t} `)));
  });
}

/** App text printed without quotes (the header, tab names) stays on its line: a newline in it can't start a fake one. */
export const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();

export const quote = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 79)}…` : s);
/** `#signIn`, or `#"pay now"` when the id isn't a plain word. */
export const ref = (id: string) => `#${/^[\w.:-]+$/.test(id) ? id : quote(id)}`;

/** One element as the agent reads it: `button "Sign In" #signIn @201,350`. */
export function line(e: Element): string {
  let out = e.kind;
  if (e.label !== undefined) out += ` ${quote(e.label)}`;
  if (e.id && e.id !== e.label) out += ` ${ref(e.id)}`;
  if (e.value) out += ` =${quote(e.value)}`;
  if (e.state) out += ` ${e.state}`;
  return `${out} @${e.x},${e.y}`;
}

export type RenderOptions = {
  /** For example "iPhone 17 Pro (iOS 26.5)". */
  device?: string;
  /** Only elements whose label, id or value contains this text (any case). */
  find?: string;
  /** Lines before the rest is summarized. */
  maxLines?: number;
};

export function render(snap: Snapshot, options: RenderOptions = {}): string {
  // A screen titled like its app (Settings · Settings) is named once.
  const header = [snap.app, snap.title === snap.app ? undefined : snap.title, options.device].filter(Boolean).map((part) => oneLine(part!)).join(" · ");
  let elements = snap.elements;
  const lines = [header];
  if (options.find) {
    const needle = options.find.toLowerCase();
    const matches = (e: Element) => [e.label, e.id, e.value].some((v) => v?.toLowerCase().includes(needle));
    elements = [...elements, ...snap.tabs].filter(matches);
    if (!elements.length) {
      lines.push(`No element matches ${quote(options.find)} (${snap.elements.length + snap.tabs.length} on screen).\nNext: ui_look without find lists them.`);
      return lines.join("\n");
    }
  }
  if (snap.window === "unknown") {
    lines.push("This app is in a window whose place on the screen could not be measured: positions are the app's own and may be off. Check with ui_look screenshot and tap @x,y.");
  } else if (snap.window) {
    const { x, y, width, height } = snap.screen, scale = Math.round(snap.window.scale * 100) / 100;
    lines.push(`This app is in a window at x ${Math.round(x)} to ${Math.round(x + width)}, y ${Math.round(y)} to ${Math.round(y + height)}${scale === 1 ? "" : `, drawn ${scale} times its size`} (an iPhone app on an iPad): positions are the screen's points, as in a screenshot.`);
  }
  if (snap.modal === "alert") lines.push("An alert is in front: answer it with one of its buttons.");
  else if (snap.modal === "screen") lines.push("Something is in front (a sheet, menu or full-screen view); the screen behind it is not listed.");
  const max = options.maxLines ?? 150;
  for (const e of elements.slice(0, max)) lines.push(line(e));
  if (elements.length > max) lines.push(`… ${elements.length - max} more; use find to narrow`);
  if (options.find) return lines.join("\n");
  for (const f of snap.unreadable) {
    const c = center(f);
    lines.push(`unreadable @${c.x},${c.y} (${Math.round(f.width)}x${Math.round(f.height)}): a web view, custom drawing or an iOS system screen; ui_look with screenshot shows it, then tap @x,y`);
  }
  // React Native apps often set a test id as the accessibility label: the screen then shows other text.
  const idLike = elements.filter((e) => e.kind === "text" && e.label && /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(e.label)).map((e) => e.label!);
  if (idLike.length) lines.push(`note: ${idLike.slice(0, 3).map((l) => quote(l)).join(", ")} ${idLike.length === 1 ? "is a test id the app set as its label" : "are test ids the app set as labels"}; the text on screen differs, and ui_look with screenshot shows it`);
  if (snap.tabs.length) lines.push(`tabs: ${snap.tabs.map((t) => `${oneLine(t.label ?? t.id ?? "")}${t.state ? ` (${t.state})` : ""} @${t.x},${t.y}`).join(", ")}`);
  const { above, below, left, right } = snap.hidden;
  const more = [snap.scroll, above && `${above} above`, below && `${below} below`, left && `${left} to the left`, right && `${right} to the right`].filter(Boolean);
  if (more.length) lines.push(`scroll: ${more.join("; ")}`);
  if (snap.keyboard) lines.push(`keyboard: shown, covering y ${snap.keyboardTop ?? "?"} and below`);
  if (!snap.elements.length && !snap.tabs.length && !snap.unreadable.length) {
    lines.push("Nothing readable on screen yet. The app may still be launching, or it shows no accessibility elements; a screenshot shows what is there.");
  }
  return lines.join("\n");
}
