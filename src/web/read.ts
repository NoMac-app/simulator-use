/**
 * Web pages in a read of the screen: where the app's tree has a web view, what the page itself says it shows
 * (page-script.ts, asked through the Simulator's Web Inspector, inspector.ts) is put there, in screen points.
 *
 * The tree gives the web view's place on the screen; the page gives its elements in its own points, counted from
 * the top left of what it shows. Where that corner is on the screen is not the web view's corner (Safari's page
 * starts under the status bar, 62 points down a web view that starts at 0), so it is found once per web view: an
 * element of the page is looked for by accessibility at where each likely corner would put it, and the corner that
 * finds it is kept while the web view and the page keep their sizes.
 */
import type { AxNode, Frame } from "../look/snapshot.ts";
import { setting } from "../settings.ts";
import { webInspector, webInspectorIfReady, type WebInspector, type WebPage } from "./inspector.ts";
import { PAGE_SCRIPT } from "./page-script.ts";

export type PageItem = {
  /** Its kind, in snapshot's words: link, button, textfield, securefield, searchfield, textview, checkbox, switch, radio, tab, popup, slider, heading, image, text, progress. */
  k: string;
  /** Its name. */
  n?: string;
  /** Its DOM id, when it has a plain one. */
  id?: string;
  /** Its value: a field's text, a select's choice, a slider's number. */
  v?: string;
  on?: boolean;
  sel?: boolean;
  off?: boolean;
  exp?: boolean;
  lvl?: number;
  /** Part of it is out of view. */
  cut?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PageRead = {
  v: number;
  url: string;
  title: string;
  visible: boolean;
  ready: string;
  /** The layout viewport, in the page's points. */
  w: number;
  h: number;
  /** The visual viewport: how far the page is zoomed, and what of it shows. */
  scale: number;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  more: boolean;
  items: PageItem[];
};

/** Roles of the engine's tree for each kind (snapshot.ts reads them back as the same kinds). */
const ROLES: Record<string, { role: string; subrole?: string }> = {
  link: { role: "AXLink" },
  button: { role: "AXButton" },
  tab: { role: "AXButton" },
  textfield: { role: "AXTextField" },
  securefield: { role: "AXTextField", subrole: "AXSecureTextField" },
  searchfield: { role: "AXSearchField" },
  textview: { role: "AXTextArea" },
  checkbox: { role: "AXCheckBox" },
  switch: { role: "AXCheckBox", subrole: "AXSwitch" },
  radio: { role: "AXRadioButton" },
  popup: { role: "AXPopUpButton" },
  slider: { role: "AXSlider" },
  heading: { role: "AXHeading" },
  image: { role: "AXImage" },
  text: { role: "AXStaticText" },
  progress: { role: "AXProgressIndicator" },
};

const area = (f: Frame) => f.width * f.height;
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hasWords = (s: string | undefined) => Boolean(s && /[\p{L}\p{N}]/u.test(s));

/** A text's words without the separators left at its ends once its links were taken out ("76 points by | |"). */
export function tidyText(text: string): string {
  const tokens = text.split(" ");
  while (tokens.length && !hasWords(tokens[0])) tokens.shift();
  while (tokens.length && !hasWords(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

/** A name for a link the page gives none (an icon): where it goes. */
export function linkName(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/+$/, "");
    return (path && path !== "/" ? decodeURIComponent(path.split("/").pop() ?? "") : url.hostname).slice(0, 40);
  } catch {
    return "";
  }
}

/** Whether a node has anything to read that the app's own tree gave (not the engine's point scan of a page). */
function ownText(node: AxNode): boolean {
  if (node.found_by) return false;
  const role = node.role ?? "";
  const label = `${node.AXLabel ?? ""}`.trim() || (role === "AXStaticText" || role === "AXHeading" || role === "AXLink" ? `${node.AXValue ?? ""}`.trim() : "");
  if (role !== "AXGroup" && role !== "AXScrollArea" && role !== "AXWebArea" && role !== "" && (label || `${node.AXUniqueId ?? ""}`.trim()) && !/^(Vertical|Horizontal) scroll bar, \d+ pages?$/.test(label)) return true;
  return (node.children ?? []).some(ownText);
}

/**
 * The web views of a tree: scroll or web areas of 15% of the screen or more with nothing of the app's own to read
 * under them (empty, or filled by the engine's point scan), outermost first. As the engine's own rule
 * (isEmptyWebArea, native/engine/main.swift), with its scan's results not counted as content.
 */
export function webAreas(roots: AxNode[]): AxNode[] {
  const screen = roots[0]?.frame;
  if (!screen || screen.width <= 0) return [];
  const out: AxNode[] = [];
  const walk = (node: AxNode) => {
    if ((node.role === "AXScrollArea" || node.role === "AXWebArea") && node.frame) {
      const f = node.frame;
      const x = Math.max(f.x, screen.x), y = Math.max(f.y, screen.y);
      const shown = Math.max(0, Math.min(f.x + f.width, screen.x + screen.width) - x) * Math.max(0, Math.min(f.y + f.height, screen.y + screen.height) - y);
      if (shown >= area(screen) * 0.15 && !ownText(node)) {
        out.push(node);
        return;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** The page's corner on the screen, and how many screen points one of the page's points is. */
export type Placement = { x: number; y: number; scale: number; how: string };

/**
 * Where the page's corner may be on the screen, likeliest first. The web view may run under bars that the page is
 * laid out clear of: what is left of the view's height once the page's own is taken is under a bar at the top, at
 * the bottom, or both (then the top one is the status bar's height, by the screen's size).
 */
export function corners(view: Frame, page: PageRead, screen: Frame): Placement[] {
  const scale = page.scale > 0 ? page.scale : 1;
  const left = view.x - page.vx * scale;
  const spare = view.height - page.vh * scale;
  const out: Placement[] = [];
  const add = (y: number, how: string) => {
    if (!out.some((p) => Math.abs(p.y - y) < 1.5)) out.push({ x: left, y: y - page.vy * scale, scale, how });
  };
  // The safe area's top on this screen: 62 on phones with a Dynamic Island, 47 to 59 on a notch, 20 to 24 else.
  const safeTop = screen.height >= 850 ? 62 : screen.height >= 800 ? 54 : screen.height >= 700 ? 47 : 20;
  if (spare < 2) add(view.y, "the view's own corner");
  else {
    if (view.y < safeTop && spare > safeTop + 20) add(view.y + safeTop, "under the status bar, a bar below");
    if (view.y < safeTop && spare <= 75) add(view.y + spare, "under a bar at the top");
    add(view.y, "the view's own corner");
    add(view.y + spare, "under a bar at the top");
    if (view.y < safeTop) add(view.y + safeTop, "under the status bar");
  }
  return out;
}

type PointRead = (x: number, y: number) => Promise<AxNode | undefined>;

/** Whether what accessibility finds at a point is this item of the page: its words, and about its size. */
function sameThing(node: AxNode | undefined, item: PageItem): boolean {
  if (!node) return false;
  const said = words(`${node.AXLabel ?? ""} ${typeof node.AXValue === "string" ? node.AXValue : ""}`);
  const name = words(item.n ?? "");
  if (!said || !name || !(said.includes(name) || name.includes(said))) return false;
  return true;
}

const placements = new Map<string, Placement>();

/**
 * The page's corner on the screen: the first likely one at which accessibility finds one of the page's named
 * elements where the page says it is (three elements tried, top, middle and bottom), then set exactly from that
 * element's own frame; without any found (a web view accessibility cannot read at all), the likeliest. Kept per web
 * view and page size.
 */
export async function place(udid: string, pid: number, view: Frame, page: PageRead, screen: Frame, pointRead: PointRead | undefined): Promise<Placement> {
  const key = `${udid}|${pid}|${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.width)},${Math.round(view.height)}|${Math.round(page.w)}x${Math.round(page.h)}|${page.scale}`;
  const kept = placements.get(key);
  if (kept) return kept;
  const likely = corners(view, page, screen);
  // Elements with a name of their own that is not all over the page (a list's "hide" links say nothing of where).
  const counts = new Map<string, number>();
  for (const item of page.items) if (item.n) counts.set(words(item.n), (counts.get(words(item.n)) ?? 0) + 1);
  const named = page.items.filter((i) => i.k !== "text" && i.n && words(i.n).length >= 4 && counts.get(words(i.n)) === 1 && i.w >= 12 && i.h >= 10 && !i.cut);
  const probes = named.length <= 3 ? named : [named[0]!, named[Math.floor(named.length / 2)]!, named[named.length - 1]!];
  if (pointRead) {
    for (const corner of likely) {
      for (const item of probes) {
        const x = corner.x + (item.x + item.w / 2) * corner.scale, y = corner.y + (item.y + item.h / 2) * corner.scale;
        if (x < screen.x || y < screen.y || x > screen.x + screen.width || y > screen.y + screen.height) continue;
        const node = await pointRead(x, y).catch(() => undefined);
        if (!sameThing(node, item)) continue;
        // Exactly: by the found element's own frame, when it is the size the page gives (a link's frame may be its
        // text's alone, or its whole line's).
        let exact = corner;
        const f = node!.frame;
        if (f && Math.abs(f.width - item.w * corner.scale) <= 3 && Math.abs(f.height - item.h * corner.scale) <= 3) {
          exact = { ...corner, x: f.x - item.x * corner.scale, y: f.y - item.y * corner.scale };
          // A frame far from where the corner put it is another element of the same name: the corner as it was.
          if (Math.abs(exact.x - corner.x) > 12 || Math.abs(exact.y - corner.y) > 12) exact = corner;
        }
        const found = { ...exact, how: `${corner.how}, checked` };
        placements.set(key, found);
        return found;
      }
    }
  }
  // Not checked: used for this read, and looked for again at the next (the page may have had nothing to check by).
  return { ...likely[0]!, how: `${likely[0]!.how}, not checked` };
}

/** One element of the page as a node of the engine's tree, in screen points. */
export function pageNode(item: PageItem, at: Placement): AxNode | undefined {
  const kind = ROLES[item.k];
  if (!kind) return undefined;
  let name = item.n ?? "";
  if (item.k === "text") {
    name = tidyText(name);
    if (!hasWords(name)) return undefined;
  }
  const node: AxNode = {
    role: kind.role,
    ...(kind.subrole ? { subrole: kind.subrole } : {}),
    frame: { x: at.x + item.x * at.scale, y: at.y + item.y * at.scale, width: item.w * at.scale, height: item.h * at.scale },
    found_by: "web_page",
    enabled: item.off !== true,
    children: [],
  };
  if (name) node.AXLabel = name;
  if (item.id) node.AXUniqueId = item.id;
  if (item.k === "checkbox" || item.k === "switch" || item.k === "radio") node.AXValue = item.on ? "1" : "0";
  else if (item.v !== undefined) node.AXValue = item.v;
  else if (item.k === "tab" && item.sel) node.AXValue = "selected";
  else if (item.exp !== undefined && (item.k === "button" || item.k === "popup")) node.AXValue = item.exp ? "expanded" : "collapsed";
  return node;
}

export type WebMerge = { pages: number; items: number; ms: number; placed?: string; note?: string };

/**
 * The tree with each web view filled from its page. Unchanged (and merged undefined) when the tree has no web view,
 * the Simulator no Web Inspector, or the app no page it lets be inspected: the engine's own scan then stands.
 */
export async function withWebPages(udid: string, roots: AxNode[], pointRead?: PointRead): Promise<{ tree: AxNode[]; merged?: WebMerge }> {
  if (setting("WEB") === "off") return { tree: roots };
  const views = webAreas(roots);
  const screen = roots[0]?.frame;
  const pid = Number((roots[0] as { pid?: unknown } | undefined)?.pid ?? 0);
  if (!views.length || !screen || !pid) return { tree: roots };
  const started = Date.now();
  const inspector = await webInspector(udid);
  if (!inspector) return { tree: roots };
  let listed: WebPage[];
  try {
    listed = await inspector.pagesOf(pid);
  } catch {
    return { tree: roots };
  }
  if (!listed.length) return { tree: roots };
  let reads = await readPages(inspector, listed);
  // A page in view that is still loading, or has nothing to show yet: a moment for it (up to 0.9 s), since a read
  // that says a page is empty sends an agent to a screenshot.
  for (let tries = 0; tries < 3 && reads.some((r) => r.visible && (r.ready === "loading" || !r.items.length)); tries++) {
    await new Promise((r) => setTimeout(r, 300));
    reads = await readPages(inspector, listed);
  }
  const shown = reads.filter((r) => r.visible);
  if (!shown.length) return { tree: roots, merged: { pages: 0, items: 0, ms: Date.now() - started, note: reads.length ? "no page in view" : "no page answered" } };
  // Each web view takes the page whose size fits it best (one view and one page nearly always).
  const free = [...shown];
  let items = 0, pages = 0, placed = "";
  const filled: Frame[] = [];
  for (const view of views.sort((a, b) => area(b.frame!) - area(a.frame!))) {
    if (!free.length) break;
    const f = view.frame!;
    free.sort((a, b) => fit(f, a) - fit(f, b));
    const page = free.shift()!;
    const at = await place(udid, pid, f, page, screen, pointRead);
    placed = at.how;
    const nodes = page.items.map((item) => pageNode(item, at)).filter((n): n is AxNode => Boolean(n));
    nodes.sort((a, b) => a.frame!.y - b.frame!.y || a.frame!.x - b.frame!.x);
    // What the app's own tree had there stays (its scroll bars); what the engine's point scan found is the page's,
    // said better by the page.
    const own = (view.children ?? []).filter((child) => child.found_by !== "point_scan");
    // The page's area again inside the web view (the app's tree nests it): the page is listed, so it is not unreadable.
    const under = (node: AxNode) => {
      if ((node.role === "AXScrollArea" || node.role === "AXWebArea") && node.frame && !node.found_by) node.found_by = "web_page_under";
      for (const child of node.children ?? []) under(child);
    };
    for (const child of own) under(child);
    const bar = scrollBar(page, f, own);
    view.children = [...own, ...(bar ? [bar] : []), ...nodes];
    items += nodes.length;
    pages++;
    filled.push(f);
  }
  // A web view left without a page that a filled one lies over (the same page's area a second time in the tree) is
  // marked, so the snapshot does not call it unreadable beside the page's own elements.
  for (const view of views) {
    const f = view.frame!;
    if (filled.includes(f) || (view.children ?? []).some((child) => child.found_by === "web_page")) continue;
    const covered = filled.some((g) => {
      const w = Math.min(f.x + f.width, g.x + g.width) - Math.max(f.x, g.x), h = Math.min(f.y + f.height, g.y + g.height) - Math.max(f.y, g.y);
      return w > 0 && h > 0 && w * h >= 0.6 * Math.min(area(f), area(g));
    });
    if (covered) view.found_by = "web_page_under";
  }
  return { tree: roots, merged: { pages, items, ms: Date.now() - started, placed } };
}

/** How badly a page's size fits a web view: 0 is exactly. */
function fit(view: Frame, page: PageRead): number {
  const scale = page.scale > 0 ? page.scale : 1;
  return Math.abs(view.width - page.vw * scale) + Math.max(0, page.vh * scale - view.height);
}

async function readPages(inspector: WebInspector, pages: WebPage[]): Promise<PageRead[]> {
  const out: PageRead[] = [];
  // One after another: a Simulator shows one or two pages, and a page that does not answer must not hold the others.
  for (const page of pages.slice(0, 6)) {
    try {
      const value = await inspector.evaluate(page, PAGE_SCRIPT, 2_500);
      const read = JSON.parse(String(value)) as PageRead;
      if (read && Array.isArray(read.items)) {
        for (const item of read.items) if (item.k === "link" && !item.n) item.n = linkName((item as { href?: string }).href ?? "");
        out.push(read);
      }
    } catch (error) {
      if (setting("DEBUG")) process.stderr.write(`simulator-use:   web page ${page.url.slice(0, 80)}: ${(error as Error).message}\n`);
    }
  }
  return out;
}

/** The page's own scrolling, said the way the app's scroll bars are (snapshot.ts reads "N pages" and where it is). */
function scrollBar(page: PageRead, view: Frame, own: AxNode[]): AxNode | undefined {
  if (own.some((n) => /^Vertical scroll bar, \d+ pages?$/.test(`${n.AXLabel ?? ""}`))) return undefined;
  const count = page.h > 0 ? Math.ceil(page.sh / page.h - 0.05) : 1;
  if (count < 2) return undefined;
  const room = page.sh - page.h;
  const at = room > 0 ? Math.max(0, Math.min(100, Math.round((page.sy / room) * 100))) : 0;
  return { role: "AXScrollBar", AXLabel: `Vertical scroll bar, ${count} pages`, AXValue: `${at}%`, frame: { x: view.x + view.width - 4, y: view.y, width: 4, height: view.height }, found_by: "web_page", children: [] };
}

let warm = false;
/** The process is a server that stays (the MCP server): the Web Inspector is connected ahead of the first web page. */
export function keepWebInspectorWarm(): void {
  warm = true;
}

/**
 * Whether this Simulator's Web Inspector is connected and lists a page now: a read then leaves the engine's own
 * page scan out (2.5 s of point reads at most), since the page will say what it shows. Never waits.
 */
export function pagesListedNow(udid: string): boolean {
  if (setting("WEB") === "off") return false;
  return webInspectorIfReady(udid, warm)?.hasPages() ?? false;
}

/** For tests: forgets every kept corner. */
export function forgetPlacements(): void {
  placements.clear();
}
