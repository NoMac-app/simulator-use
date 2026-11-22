import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePlist, encodePlist } from "../src/web/bplist.ts";
import { PAGE_SCRIPT } from "../src/web/page-script.ts";
import { corners, linkName, pageNode, tidyText, webAreas, type PageRead } from "../src/web/read.ts";
import { snapshot, type AxNode } from "../src/look/snapshot.ts";

test("a binary property list comes back as it went: every type the Web Inspector speaks", () => {
  const message = {
    __selector: "_rpc_forwardSocketData:",
    __argument: {
      WIRConnectionIdentifierKey: "0C46D6F9-8441-4298-8CA9-2AABC28217FC",
      WIRPageIdentifierKey: 1,
      big: 70_000,
      bigger: 5_000_000_000,
      negative: -3,
      real: 1.5,
      yes: true,
      no: false,
      none: null,
      data: Buffer.from('{"id":1,"method":"Runtime.evaluate"}'),
      words: "árvíztűrő 日本語 😀",
      list: ["a", 2, ["nested"], {}],
      long: "x".repeat(300),
    },
  };
  assert.deepEqual(decodePlist(encodePlist(message)), message);
  // More than 14 members, and more than 255 objects: counts and references of more than one byte.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 400; i++) wide[`key${i}`] = i;
  assert.deepEqual(decodePlist(encodePlist(wide)), wide);
});

test("what is not a binary property list is refused, never read past its end", () => {
  assert.throws(() => decodePlist(Buffer.from("not a plist at all, but long enough to hold a trailer")), /not a binary property list/);
  const good = encodePlist({ a: "b" });
  assert.throws(() => decodePlist(good.subarray(0, good.length - 5)));
  // A trailer that points past the data.
  const bad = Buffer.from(good);
  bad.writeBigUInt64BE(9_999n, bad.length - 8);
  assert.throws(() => decodePlist(bad), /bad trailer/);
});

test("the page's script is one expression that parses", () => {
  assert.doesNotThrow(() => new Function(`return ${PAGE_SCRIPT}`));
  assert.ok(PAGE_SCRIPT.length < 20_000, "small enough to send with every read");
});

const page = (over: Partial<PageRead> = {}): PageRead => ({ v: 1, url: "https://example.com/", title: "Example", visible: true, ready: "complete", w: 402, h: 714, scale: 1, vx: 0, vy: 0, vw: 402, vh: 714, sx: 0, sy: 0, sw: 402, sh: 1967, more: false, items: [], ...over });
const screen = { x: 0, y: 0, width: 402, height: 874 };

test("where a page's corner may be: Safari's under the status bar first, a web view that fits its page at its own corner", () => {
  // Safari on an iPhone 17 Pro, measured November 22, 2026: the web view is the whole screen, the page 714 points
  // tall, and its corner is at y 62.
  const safari = corners({ x: 0, y: 0, width: 402, height: 874 }, page(), screen);
  assert.equal(safari[0]!.y, 62);
  assert.ok(safari.some((c) => c.y === 0) && safari.some((c) => c.y === 160));
  // An app's web view under its navigation bar: the page is as tall as the view.
  const inApp = corners({ x: 0, y: 168, width: 402, height: 623 }, page({ h: 623, vh: 623 }), screen);
  assert.deepEqual(inApp.map((c) => [c.x, c.y]), [[0, 168]]);
  // A page zoomed out (no viewport tag: 980 points across a 402-point view): its points are smaller than the screen's.
  const zoomed = corners({ x: 0, y: 168, width: 402, height: 623 }, page({ w: 980, h: 1519, vw: 980, vh: 1519, scale: 402 / 980 }), screen);
  assert.equal(zoomed[0]!.y, 168);
  assert.ok(Math.abs(zoomed[0]!.scale - 0.41) < 0.01);
});

test("a page's elements become the tree's, in screen points, and read as the kinds they are", () => {
  const at = { x: 0, y: 62, scale: 1, how: "test" };
  const link = pageNode({ k: "link", n: "Hacker News", x: 32, y: 5, w: 110, h: 20 }, at)!;
  assert.deepEqual(link.frame, { x: 32, y: 67, width: 110, height: 20 });
  const nodes = [
    link,
    pageNode({ k: "textfield", n: "Email", id: "email", v: "a@b.co", x: 20, y: 100, w: 300, h: 40 }, at)!,
    pageNode({ k: "securefield", n: "Password", v: "•••", x: 20, y: 150, w: 300, h: 40 }, at)!,
    pageNode({ k: "checkbox", n: "Remember me", on: true, x: 20, y: 200, w: 24, h: 24 }, at)!,
    pageNode({ k: "button", n: "Sign in", off: true, x: 20, y: 240, w: 100, h: 44 }, at)!,
    pageNode({ k: "text", n: "76 points by | |", x: 20, y: 300, w: 200, h: 16 }, at)!,
    pageNode({ k: "heading", n: "Welcome", lvl: 1, x: 20, y: 330, w: 200, h: 30 }, at)!,
  ];
  assert.equal(pageNode({ k: "text", n: "| | |", x: 0, y: 0, w: 50, h: 10 }, at), undefined, "separators alone are not text");
  const view: AxNode = { role: "AXScrollArea", frame: { x: 0, y: 0, width: 402, height: 874 }, children: nodes };
  const app: AxNode = { role: "AXApplication", AXLabel: "Safari", frame: screen, children: [{ role: "AXGroup", frame: screen, children: [view] }] };
  const snap = snapshot([app]);
  const lines = snap.elements.map((e) => `${e.kind} ${e.label ?? ""}${e.id ? ` #${e.id}` : ""}${e.value ? ` =${e.value}` : ""}${e.state ? ` ${e.state}` : ""}`);
  assert.deepEqual(lines, ["link Hacker News", "textfield Email #email =a@b.co", "securefield Password =•••", "checkbox Remember me on", "button Sign in disabled", "text 76 points by", "heading Welcome"]);
  assert.ok(snap.elements.every((e) => e.web), "each is marked as a web page's");
  assert.equal(snap.unreadable.length, 0, "a web view with its page is not unreadable");
});

test("a web view is a large scroll area with nothing of the app's own to read; one the engine's scan filled is still one", () => {
  const bar: AxNode = { role: "AXGroup", AXLabel: "Vertical scroll bar, 3 pages", AXValue: "0%", frame: { x: 396, y: 0, width: 4, height: 874 } };
  const empty: AxNode = { role: "AXScrollArea", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [bar] };
  const scanned: AxNode = { role: "AXScrollArea", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ role: "AXLink", AXLabel: "new", found_by: "point_scan", frame: { x: 30, y: 87, width: 25, height: 16 } }] };
  const list: AxNode = { role: "AXScrollArea", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ role: "AXButton", AXLabel: "Item 1", frame: { x: 0, y: 100, width: 402, height: 52 } }] };
  const small: AxNode = { role: "AXScrollArea", frame: { x: 0, y: 0, width: 402, height: 100 }, children: [] };
  const app = (child: AxNode): AxNode[] => [{ role: "AXApplication", frame: screen, children: [child] }];
  assert.equal(webAreas(app(empty)).length, 1);
  assert.equal(webAreas(app(scanned)).length, 1);
  assert.equal(webAreas(app(list)).length, 0);
  assert.equal(webAreas(app(small)).length, 0);
});

test("texts lose the separators at their ends, and a link without words is named by where it goes", () => {
  assert.equal(tidyText("76 points by | |"), "76 points by");
  assert.equal(tidyText("| Tom & Jerry ·"), "Tom & Jerry");
  assert.equal(tidyText("( )"), "");
  assert.equal(linkName("https://news.ycombinator.com/"), "news.ycombinator.com");
  assert.equal(linkName("https://example.com/docs/getting%20started/"), "getting started");
  assert.equal(linkName("not a link"), "");
});
