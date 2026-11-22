import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseStep } from "../src/act/steps.ts";
import { type AxNode, render, snapshot } from "../src/look/snapshot.ts";
import { sliderPercent } from "../src/tools/ui-act.ts";

// Real describe-ui trees from examples/edge-lab on iPhone 17 Pro, iOS 26.5 (October 19, 2026).
const look = (name: string) => render(snapshot(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8")) as AxNode[]));

test("controls: rounded slider values, stepper buttons, segments apart from the tab bar, no repeated labels", () => {
  const out = look("lab-controls");
  assert.match(out, /^slider "Volume" #volume ="0\.3" @201,239$/m);
  assert.match(out, /^button "Count: 2, Increment" #count-Increment ="2" @347,295$/m);
  assert.match(out, /^segment "M" selected @201,404$/m);
  assert.match(out, /^tabs: Controls \(selected\) @64,822, Dialogs/m);
  assert.doesNotMatch(out, /tabs: S|tabgroup|^text "Count: 2"|^text "Flavor"|^text "Date"/m);
});

test("a sheet: only the sheet, its Done button reachable, the screen behind left out", () => {
  const out = look("lab-sheet");
  assert.match(out, /^EdgeLab · Sheet$/m);
  assert.match(out, /^Something is in front/m);
  assert.match(out, /^button "Done" @350,100$/m);
  assert.doesNotMatch(out, /Show alert|tabs:/);
});

test("a full-screen cover hides the screen it covers", () => {
  const out = look("lab-cover");
  assert.match(out, /^button "Close" #closeCover @201,481$/m);
  assert.doesNotMatch(out, /Show alert|tabs:/);
});

test("the app's own alert: its message and buttons, its title once", () => {
  const out = look("lab-alert");
  assert.equal(
    out,
    ["EdgeLab", "An alert is in front: answer it with one of its buttons.", 'alert "Delete everything?" @201,451', 'text "This cannot be undone." @201,434', 'button "Cancel" @127,487', 'button "Delete" @275,487'].join("\n"),
  );
});

test("iOS's permission prompt is read over the app, named after it, without scroll lines", () => {
  const out = look("lab-location");
  assert.match(out, /^EdgeLab · system alert$/m);
  assert.match(out, /^button "Allow While Using App" @201,498$/m);
  assert.doesNotMatch(out, /Home screen|scroll:|Cellular|battery/);
});

test("a list with a carousel: the main scroller, cards off to the right counted as such", () => {
  const out = look("lab-lists");
  assert.match(out, /^scroll: 4 pages, at top; 2 below; 7 to the right$/m);
  assert.doesNotMatch(out, /horizontal/);
});

test("a web view says it can't be read and what to do instead", () => {
  assert.match(look("lab-web"), /^unreadable @201,480 \(402x623\): a web view, custom drawing or an iOS system screen; ui_look with screenshot shows it, then tap @x,y$/m);
});

test("navigation inside navigation: both back buttons, the real title", () => {
  const out = look("lab-uikit-detail");
  assert.match(out, /^EdgeLab · UIKit table$/m);
  assert.doesNotMatch(out, /_Tt|Hosting/);
});

test("text in any language, quotes and new lines, read as written", () => {
  const out = look("lab-text");
  assert.match(out, /^text "Café crème · 日本語 · 🚀 rocket · مرحبا" @201,254$/m);
  assert.match(out, /^text "He said \\"hi\\"\\nthen left" @201,316$/m);
});

test("the new steps: hold, set, and swipe or scroll on one element", () => {
  assert.deepEqual(parseStep('hold "Row 5"'), { op: "hold", target: { by: "label", label: "Row 5" }, seconds: 1 });
  // Unquoted, with a number at its end: "Row 5" for 2 s, or the element "Row 5 2" when the screen has one (whole).
  assert.deepEqual(parseStep("hold Row 5 2"), { op: "hold", target: { by: "label", label: "Row 5" }, seconds: 2, whole: { by: "label", label: "Row 5 2" } });
  assert.deepEqual(parseStep("hold Row 3"), { op: "hold", target: { by: "label", label: "Row" }, seconds: 3, whole: { by: "label", label: "Row 3" } });
  assert.deepEqual(parseStep('hold "Row 5" 2'), { op: "hold", target: { by: "label", label: "Row 5" }, seconds: 2 });
  assert.deepEqual(parseStep("hold #photo 30"), { op: "hold", target: { by: "id", id: "photo" }, seconds: 10 });
  assert.deepEqual(parseStep("set #volume 75"), { op: "set", target: { by: "id", id: "volume" }, percent: 75 });
  assert.deepEqual(parseStep("set Volume 40%"), { op: "set", target: { by: "label", label: "Volume" }, percent: 40 });
  assert.match(String(parseStep("set #volume 140")), /percent from 0 to 100/);
  assert.deepEqual(parseStep('swipe left "Row 3"'), { op: "swipe", direction: "left", target: { by: "label", label: "Row 3" } });
  assert.deepEqual(parseStep("swipe left Row 3"), { op: "swipe", direction: "left", target: { by: "label", label: "Row 3" } });
  assert.deepEqual(parseStep("scroll right @201,402"), { op: "scroll", direction: "right", target: { by: "point", x: 201, y: 402 } });
  assert.deepEqual(parseStep("scroll down"), { op: "scroll", direction: "down" });
});

test("a slider's value as a percent, whatever form the app reports", () => {
  assert.equal(sliderPercent("0.75"), 75);
  assert.equal(sliderPercent("75%"), 75);
  assert.equal(sliderPercent("40"), 40);
  assert.equal(sliderPercent("loud"), undefined);
});

test("an iOS system screen over the app (the contacts picker) is named, and said to be unreadable", () => {
  const out = look("system-contacts-picker");
  assert.match(out, /^EdgeLab · system screen$/m);
  assert.match(out, /^unreadable @201,437 \(402x874\): a web view, custom drawing or an iOS system screen/m);
  assert.doesNotMatch(out, /Home screen|Cellular|battery|AM"/);
});

test("iPad: tabs at the top (no Tab Bar group, each nested in its twin) are tabs, and nothing is wrongly in front", () => {
  const out = look("ipad-login");
  assert.match(out, /^tabs: Login \(selected\) @372,54, Items @448,54$/m);
  assert.match(out, /^button "Sign In" #signIn @410,320$/m);
  assert.doesNotMatch(out, /Something is in front|segment|above/);
});
