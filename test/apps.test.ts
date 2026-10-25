import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgs } from "../src/cli.ts";
import { freshFile, install, plistValue } from "../src/engine/apps.ts";
import { cleanConsole, crashReports, parseSystemLog, summarizeIps } from "../src/engine/logs.ts";
import { appControl, pushJson } from "../src/tools/app-control.ts";
import { parseSince } from "../src/tools/app-logs.ts";
import { ToolError } from "../src/errors.ts";

// Lines as `log show --style compact` printed them for the sample app on iOS 26.5.
const LOG = `Timestamp               Ty Process[PID:TID]
2026-10-19 01:56:17.408 Df Demo[94957:88904] (libMobileGestalt.dylib) No persisted cache on this platform.
2026-10-19 01:56:17.418 A  Demo[94957:88912] (RunningBoardServices) didChangeInheritances
2026-10-19 01:56:21.399 E  Demo[94957:88904] [com.apple.UIKit:UIKBFeedbackGenerator] Error creating CHHapticPattern
2026-10-19 01:56:22.114 E  Demo[94957:88904] [dev.simtap.demo:login] sign-in rejected: invalid email or password
2026-10-19 01:57:23.051 I  Demo[94957:88904] [dev.simtap.demo:login] signed in
2026-10-19 01:57:24.000 Df Demo[94957:88904] (Demo) plain NSLog line`;

test("system log lines read short: time, level, the app's own category, the message", () => {
  const lines = parseSystemLog(LOG, "dev.simtap.demo");
  assert.deepEqual(
    lines.map((l) => `${l.time} ${l.level}|${l.text}`),
    [
      "01:56:17.408 |(libMobileGestalt.dylib): No persisted cache on this platform.",
      "01:56:21.399 error|com.apple.UIKit:UIKBFeedbackGenerator: Error creating CHHapticPattern",
      "01:56:22.114 error|login: sign-in rejected: invalid email or password",
      "01:57:23.051 info|login: signed in",
      "01:57:24.000 |(Demo): plain NSLog line",
    ],
  );
  // Activity lines (type A) are never kept.
  assert.ok(!lines.some((l) => l.text.includes("didChangeInheritances")));
});

test("print output loses the Simulator's start-up noise and carriage returns", () => {
  const text = "objc[94461]: Class UIAccessibilityLoaderWebShared is implemented in both /a and /b. One of the duplicates must be removed or renamed.\r\nSign In tapped, ok: false\r\n\r\nDemo/App.swift:64: Fatal error: Demo crash\r\n";
  assert.deepEqual(cleanConsole(text), ["Sign In tapped, ok: false", "Demo/App.swift:64: Fatal error: Demo crash"]);
});

test("a crash report becomes the exception, the reason and the frames down to the app's own", () => {
  const ips = readFileSync(new URL("fixtures/crash-fatal-error.ips", import.meta.url), "utf8");
  const summary = summarizeIps(ips, "Demo");
  assert.equal(summary[0], "exception: EXC_BREAKPOINT SIGTRAP");
  assert.equal(summary[1], "reason: Trace/BPT trap: 5");
  assert.equal(summary[2], "crashed thread:");
  assert.equal(summary[3], "  libswiftCore.dylib _assertionFailure(_:_:file:line:flags:)");
  assert.match(summary[4]!, /^ {2}Demo\.debug\.dylib closure .* in ItemsView\.body\.getter \(App\.swift:64\)$/);
  // Two frames past the app's last one, then the framework's internals are left out.
  assert.equal(summary.length, 7);
  assert.deepEqual(summarizeIps("{}\nnot json"), ["(unreadable crash report)"]);
});

test("since takes 30s, 5m, 1h or seconds, capped at an hour", () => {
  assert.equal(parseSince(undefined), 300);
  assert.equal(parseSince("30s"), 30);
  assert.equal(parseSince("5m"), 300);
  assert.equal(parseSince("2h"), 3600);
  assert.equal(parseSince("90"), 90);
  assert.match(String(parseSince("yesterday")), /like 30s, 5m or 1h/);
});

test("a push from plain text, or the agent's JSON checked the way simctl will", () => {
  assert.deepEqual(JSON.parse(pushJson("Your order shipped")), { aps: { alert: "Your order shipped", sound: "default" } });
  assert.equal(pushJson('{"aps":{"alert":"Hi"},"orderId":7}'), '{"aps":{"alert":"Hi"},"orderId":7}');
  assert.throws(() => pushJson('{"alert":"Hi"}'), (e: unknown) => e instanceof ToolError && /needs an "aps" object/.test(e.message));
  assert.throws(() => pushJson("{nope"), (e: unknown) => e instanceof ToolError && /not valid JSON/.test(e.message));
  assert.throws(() => pushJson(JSON.stringify({ aps: { alert: "x".repeat(5000) } })), /over 4 KB/);
});

test("simctl appinfo's plist reads by key", () => {
  const info = 'CFBundleDisplayName = Demo;\n    CFBundleExecutable = Demo;\n    CFBundleIdentifier = "dev.simtap.demo";';
  assert.equal(plistValue(info, "CFBundleExecutable"), "Demo");
  assert.equal(plistValue(info, "CFBundleIdentifier"), "dev.simtap.demo");
  assert.equal(plistValue(info, "CFBundleVersion"), undefined);
});

test("the CLI reads app_control the way people type it", () => {
  assert.deepEqual(parseArgs(appControl, ["launch", "dev.example.app"]), { action: "launch", value: "dev.example.app" });
  assert.deepEqual(parseArgs(appControl, ["grant", "photos", "--app", "dev.example.app"]), { action: "grant", value: "photos", app: "dev.example.app" });
  assert.deepEqual(parseArgs(appControl, ["location", "47.4979,19.0402"]), { action: "location", value: "47.4979,19.0402" });
  assert.match(String(parseArgs(appControl, ["push", "hi", "extra"])), /Unexpected "extra"/);
});

test("a relaunch's console file holds only the new launch's lines, while the old launcher still writes", () => {
  // October 23: the old launcher kept writing at its offset into the truncated file, leaving NUL bytes.
  const file = join(mkdtempSync(join(tmpdir(), "su-console-")), "dev.example.app.console.log");
  const old = openSync(file, "w");
  writeSync(old, "the first launch printed this line\n");
  const fresh = freshFile(file);
  writeSync(fresh, "second launch\n");
  writeSync(old, "the first launch ending\n");
  closeSync(old);
  closeSync(fresh);
  const text = readFileSync(file, "utf8");
  assert.equal(text, "second launch\n");
  assert.equal(text.includes("\0"), false);
});

test("an install refused for an app that needs a later iOS says which, and how to fix it", { skip: process.platform !== "darwin" }, async () => {
  const app = join(mkdtempSync(join(tmpdir(), "su-min-os-")), "Demo.app");
  mkdirSync(app);
  writeFileSync(join(app, "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.demo</string><key>MinimumOSVersion</key><string>27.1</string></dict></plist>\n');
  // No such Simulator, so simctl refuses at once and none is touched.
  const none = "00000000-0000-0000-0000-000000000000";
  await assert.rejects(install(none, app, "iOS 27.0"), (error: ToolError) => {
    assert.equal(error.message, `Could not install ${app}: it needs iOS 27.1 (its deployment target) and this Simulator runs iOS 27.0.`);
    assert.equal(error.next, "Build it with a deployment target of iOS 27.0 or earlier (IPHONEOS_DEPLOYMENT_TARGET), then install it again.");
    return true;
  });
  // A phone on that iOS or later, or no runtime known: the refusal as simctl gave it.
  for (const runtime of ["iOS 27.1", undefined]) {
    await assert.rejects(install(none, app, runtime), (error: ToolError) => /^Could not install .*: xcrun simctl: /.test(error.message) && /iphonesimulator/.test(error.next ?? ""));
  }
});

test("crash reports are the app's own on this Simulator: another app named the same, or another device, is left out", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "su-crashes-"));
  const here = "B618F794-4904-462A-B413-DCB46824A2DE", other = "0D0C2E7A-1111-4222-8333-944455556666";
  const report = (bundle: string, udid: string, symbol: string) =>
    `${JSON.stringify({ app_name: "Demo", bundleID: bundle, bug_type: "309" })}\n${JSON.stringify({
      captureTime: "2026-10-25 10:00:00.0000 +0000", procPath: `/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/Demo.app/Demo`,
      coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`, exception: { type: "EXC_BREAKPOINT", signal: "SIGTRAP" }, faultingThread: 0,
      threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol }] }], usedImages: [{ name: "Demo" }] })}`;
  writeFileSync(join(dir, "Demo-2026-10-25-100001.ips"), report("dev.simtap.demo", here, "mine"));
  writeFileSync(join(dir, "Demo-2026-10-25-100002.ips"), report("dev.deviceloop.demo", here, "another app's"));
  writeFileSync(join(dir, "Demo-2026-10-25-100003.ips"), report("dev.simtap.demo", other, "another device's"));
  const crashes = await crashReports("Demo", 0, { bundleId: "dev.simtap.demo", udid: here, dir });
  assert.deepEqual(crashes.map((c) => c.file), [join(dir, "Demo-2026-10-25-100001.ips")]);
  assert.ok(crashes[0]!.summary.some((l) => l.includes("mine")));
});
