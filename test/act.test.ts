import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { diff } from "../src/act/diff.ts";
import { fieldAt, isResolved, resolve } from "../src/act/resolve.ts";
import { maskedStep, parseStep } from "../src/act/steps.ts";
import { type AxNode, snapshot } from "../src/look/snapshot.ts";
import { readBackVerdict } from "../src/tools/ui-act.ts";

const screen = (name: string) => snapshot(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8")) as AxNode[]);

test("steps read the way ui_look prints elements", () => {
  assert.deepEqual(parseStep("tap #signIn"), { op: "tap", target: { by: "id", id: "signIn" } });
  assert.deepEqual(parseStep('tap "Sign In"'), { op: "tap", target: { by: "label", label: "Sign In" } });
  assert.deepEqual(parseStep("tap Sign In"), { op: "tap", target: { by: "label", label: "Sign In" } });
  assert.deepEqual(parseStep('tap button "Sign In"'), { op: "tap", target: { by: "label", label: "Sign In", kind: "button" } });
  assert.deepEqual(parseStep("tap @201,350"), { op: "tap", target: { by: "point", x: 201, y: 350 } });
  assert.deepEqual(parseStep('tap #"pay now"'), { op: "tap", target: { by: "id", id: "pay now" } });
  assert.deepEqual(parseStep("fill #email gary@example.com"), { op: "fill", target: { by: "id", id: "email" }, text: "gary@example.com" });
  assert.deepEqual(parseStep('fill "Search" "  two spaces  "'), { op: "fill", target: { by: "label", label: "Search" }, text: "  two spaces  " });
  assert.deepEqual(parseStep("fill #email o'neil@example.com"), { op: "fill", target: { by: "id", id: "email" }, text: "o'neil@example.com" });
  assert.deepEqual(parseStep("type hello world"), { op: "type", text: "hello world" });
  assert.deepEqual(parseStep("scroll down"), { op: "scroll", direction: "down" });
  assert.deepEqual(parseStep("swipe Left"), { op: "swipe", direction: "left" });
  assert.deepEqual(parseStep('wait "Welcome"'), { op: "wait", target: { by: "label", label: "Welcome" }, seconds: 5 });
  assert.deepEqual(parseStep("wait Welcome back 10"), { op: "wait", target: { by: "label", label: "Welcome back" }, seconds: 10 });
  assert.deepEqual(parseStep("wait #status 99"), { op: "wait", target: { by: "id", id: "status" }, seconds: 30 });
  assert.deepEqual(parseStep('gone "Loading"'), { op: "gone", target: { by: "label", label: "Loading" }, seconds: 5 });
  assert.deepEqual(parseStep("key return"), { op: "key", key: "return" });
  assert.deepEqual(parseStep("back"), { op: "back" });
  assert.deepEqual(parseStep("home"), { op: "home" });
});

test("a bad step says what is wrong", () => {
  assert.match(String(parseStep("jump")), /Unknown step "jump"\. Steps: tap, fill/);
  assert.match(String(parseStep("fill #email")), /fill needs a target and the text/);
  assert.match(String(parseStep("scroll sideways")), /up, down, left or right/);
  assert.match(String(parseStep("key f13")), /key takes one of: return, escape, delete, tab, space/);
  assert.match(String(parseStep('tap "Sign In')), /Missing closing quote/);
  assert.match(String(parseStep("back now")), /back takes nothing/);
});

test("targets resolve by id, exact label, kind, then a unique partial label", () => {
  const login = screen("login");
  const at = (step: string) => {
    const s = parseStep(step);
    assert.ok(typeof s !== "string" && "target" in s && s.target);
    const r = resolve(login, s.target);
    return isResolved(r) ? `${r.element?.kind ?? "point"} @${r.x},${r.y}` : r.error;
  };
  assert.equal(at("tap #signIn"), "button @201,350");
  assert.equal(at('tap "sign in"'), "button @201,350");
  assert.equal(at("tap Remember"), "switch @341,298");
  assert.equal(at("tap Items"), "tab @244,822");
  assert.equal(at("tap #person"), "tab @158,822");
  assert.equal(at("tap @10,20"), "point @10,20");
  assert.equal(at('tap text "Not signed in"'), "text @201,402");
  assert.equal(at("tap #nope"), "No #nope on screen.");
});

test("an ambiguous label lists the candidates instead of guessing", () => {
  const r = resolve(screen("items"), { by: "label", label: "Item 1" });
  assert.ok(isResolved(r), "the exact label wins over Item 10, 11 and 12");
  const many = resolve(screen("items"), { by: "label", label: "item" });
  assert.ok(!isResolved(many));
  // Twelve rows and the Items tab.
  assert.match(many.error, /^13 elements match "item": button "Item 1" @201,194 · button "Item 2"/);
  assert.equal(many.ambiguous, true);
});

test("a partial label is words of its own, never the opposite: tap Allow is not Don’t Allow", () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };
  const prompt = (...labels: string[]) => ({ app: "Demo · system alert", elements: labels.map((label, i) => ({ kind: "button", label, x: 100 + i, y: 500, frame })), tabs: [], keyboard: false, hidden: { above: 0, below: 0, left: 0, right: 0 }, unreadable: [], screen: { x: 0, y: 0, width: 402, height: 874 }, modal: "alert" as const });
  const tap = (snap: ReturnType<typeof prompt>, label: string) => {
    const r = resolve(snap, { by: "label", label });
    return isResolved(r) ? r.element?.label : r.error;
  };
  // iOS's contacts prompt: Don’t Allow and Continue. There is no Allow to tap.
  assert.equal(tap(prompt("Don’t Allow", "Continue"), "Allow"), 'No "Allow" on screen.');
  assert.equal(tap(prompt("Don't Allow", "OK"), "allow"), 'No "allow" on screen.');
  assert.equal(tap(prompt("Do Not Allow", "OK"), "Allow"), 'No "Allow" on screen.');
  assert.equal(tap(prompt("Disallow", "OK"), "Allow"), 'No "Allow" on screen.');
  assert.equal(tap(prompt("Not Now", "Turn On"), "Now"), 'No "Now" on screen.');
  // Words of the label still match, in any place.
  assert.equal(tap(prompt("Allow While Using App", "Don’t Allow"), "Allow"), "Allow While Using App");
  assert.equal(tap(prompt("Count: 2, Increment", "Count: 2, Decrement"), "Increment"), "Count: 2, Increment");
  assert.equal(tap(prompt("Don’t Allow", "Allow"), "Allow"), "Allow", "the exact label first");
  assert.equal(tap(prompt("Email address", "Send"), "mail"), 'No "mail" on screen.', "part of a word is not a word");
});

test("a target hidden below points to scrolling", () => {
  const r = resolve(screen("items"), { by: "label", label: "Item 13" });
  assert.ok(!isResolved(r));
  assert.match(r.next, /^2 elements are below: scroll down/);
});

test("the diff after signing in names only what changed", () => {
  assert.equal(diff(screen("login"), screen("login-welcome")), 'changed: #email "gary@example.com" · #password "•••••••" · #status "Welcome, gary@example.com"');
  assert.equal(diff(screen("login"), screen("login")), "no visible change");
});

test("a new screen comes back whole, with its header", () => {
  const out = diff(screen("items"), screen("item-detail"), "iPhone 17 Pro (iOS 26.5)");
  assert.match(out, /^screen:\nDemo · Item 3 · iPhone 17 Pro \(iOS 26\.5\)\nback "Items" #BackButton @38,84/);
  // A scroll moves every row: the screen comes back whole rather than as a list of moves.
  assert.match(diff(screen("items"), screen("items-scrolled")), /^screen:\n/);
});

test("ids that show up late are not changes", () => {
  const before = screen("login");
  const after = screen("login");
  for (const t of before.tabs) delete t.id;
  assert.equal(diff(before, after), "no visible change");
});

test("typed text read back: exact, reformatted, or wrong", () => {
  assert.equal(readBackVerdict("textfield", "gary@example.com", "gary@example.com"), "exact");
  assert.equal(readBackVerdict("textfield", "(555) 123-4567", "5551234567"), "close");
  assert.equal(readBackVerdict("textfield", "Gary", "gary"), "close");
  assert.equal(readBackVerdict("textfield", "gary@exampl", "gary@example.com"), "wrong");
  assert.equal(readBackVerdict("textfield", "Email", ""), "wrong");
  assert.equal(readBackVerdict("securefield", "•••••••", "secret1"), "exact");
  assert.equal(readBackVerdict("securefield", "••••", "secret1"), "wrong");
  assert.equal(readBackVerdict("securefield", "Password", "Password"), "wrong");
});

test("fill at a point knows the field under it, the smallest when fields nest, and only text fields", () => {
  const field = (kind: string, id: string, x: number, y: number, width: number, height: number) => ({ kind, id, x: x + width / 2, y: y + height / 2, frame: { x, y, width, height } });
  const elements = [
    field("textfield", "email", 20, 180, 362, 44),
    field("securefield", "password", 20, 224, 362, 44),
    field("textview", "notes", 0, 300, 402, 400),
    field("searchfield", "inside", 20, 320, 362, 44),
    field("button", "signIn", 20, 760, 362, 44),
  ];
  assert.equal(fieldAt(elements, { x: 201, y: 246 })?.id, "password");
  assert.equal(fieldAt(elements, { x: 201, y: 340 })?.id, "inside");
  assert.equal(fieldAt(elements, { x: 201, y: 600 })?.id, "notes");
  assert.equal(fieldAt(elements, { x: 201, y: 782 }), undefined);
});

test("one id on several elements is ambiguous, not a silent tap on the first", () => {
  const snap = screen("login");
  const row = (y: number) => ({ kind: "button", label: `Row ${y}`, id: "row", x: 201, y, frame: { x: 16, y: y - 20, width: 370, height: 40 } });
  snap.elements.push(row(500), row(560));
  const r = resolve(snap, { by: "id", id: "row" });
  assert.ok(!isResolved(r));
  assert.match(r.error, /^2 elements match #row/);
});

test("a step an answer repeats leaves out what a fill or type typed", () => {
  assert.equal(maskedStep("  fill #password hunter2"), "fill #password …");
  assert.equal(maskedStep('fill "Password" "hunter2\\nmore"'), 'fill "Password" …');
  assert.equal(maskedStep("type hunter2 more"), "type …");
  assert.equal(maskedStep("Fill"), "fill …");
  assert.equal(maskedStep(' tap "Sign in" '), 'tap "Sign in"');
});
