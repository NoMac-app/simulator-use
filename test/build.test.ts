import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getJob, startJob, waitFor } from "../src/engine/jobs.ts";
import { buildCommand, deploymentTarget, findProject, formatIssue, knownFix, laterVersion, parseIssue, targetTooNew } from "../src/engine/xcode.ts";
import { ToolError } from "../src/errors.ts";

test("xcodebuild lines become errors and warnings with their place", () => {
  assert.deepEqual(parseIssue("/Users/me/app/Sources/App.swift:49:37: error: cannot convert value of type 'ClosedRange<Int>' to specified type '[String]'"), {
    file: "/Users/me/app/Sources/App.swift",
    line: 49,
    column: 37,
    severity: "error",
    message: "cannot convert value of type 'ClosedRange<Int>' to specified type '[String]'",
  });
  assert.equal(parseIssue("/Users/me/app/Sources/App.swift:12:5: warning: variable 'x' was never used")?.severity, "warning");
  assert.deepEqual(parseIssue("xcodebuild: error: Unable to find a destination matching the provided destination specifier"), {
    severity: "error",
    message: "Unable to find a destination matching the provided destination specifier",
  });
  assert.equal(parseIssue("ld: library 'Pods-Demo' not found")?.severity, "error");
  assert.equal(parseIssue("CompileSwift normal arm64 /Users/me/app/Sources/App.swift"), undefined);
  assert.equal(parseIssue("** BUILD FAILED **"), undefined);
});

test("issues read relative to the project, absolute outside it", () => {
  const issue = { file: "/Users/me/app/Sources/App.swift", line: 49, column: 37, severity: "error" as const, message: "boom" };
  assert.equal(formatIssue(issue, "/Users/me/app"), "Sources/App.swift:49:37: error: boom");
  assert.equal(formatIssue(issue, "/Users/me/other"), "/Users/me/app/Sources/App.swift:49:37: error: boom");
  assert.equal(formatIssue({ severity: "error", message: "no file" }, "/x"), "error: no file");
});

test("finding the project: workspace first, then project, then ios/ (React Native too), and the next step for other kinds", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-find-"));
  const both = join(root, "both");
  mkdirSync(join(both, "App.xcworkspace"), { recursive: true });
  mkdirSync(join(both, "App.xcodeproj"), { recursive: true });
  assert.equal((await findProject(both)).kind, "workspace");
  const rn = join(root, "rn");
  mkdirSync(join(rn, "ios", "MyApp.xcodeproj"), { recursive: true });
  writeFileSync(join(rn, "package.json"), "{}");
  assert.equal((await findProject(rn)).name, "MyApp");
  const expo = join(root, "expo");
  mkdirSync(expo);
  writeFileSync(join(expo, "app.json"), '{"expo": {"name": "x"}}');
  await assert.rejects(findProject(expo), (e: unknown) => e instanceof ToolError && /An Expo project with no ios\/ folder yet/.test(e.message) && /expo prebuild/.test(e.next ?? ""));
  // A React Native CLI project has an app.json too: its ios/ workspace is built, with a word about Metro.
  const rnCli = join(root, "rn-cli");
  mkdirSync(join(rnCli, "ios", "Shop.xcworkspace"), { recursive: true });
  writeFileSync(join(rnCli, "app.json"), '{"name": "Shop", "displayName": "Shop"}');
  const shop = await findProject(rnCli);
  assert.equal(shop.kind, "workspace");
  assert.match(shop.note ?? "", /Metro/);
  const pods = join(root, "rn-pods");
  mkdirSync(join(pods, "ios", "Shop.xcodeproj"), { recursive: true });
  writeFileSync(join(pods, "ios", "Podfile"), "");
  writeFileSync(join(pods, "app.json"), '{"name": "Shop"}');
  await assert.rejects(findProject(pods), (e: unknown) => e instanceof ToolError && /Podfile but no workspace/.test(e.message) && /pod install/.test(e.next ?? ""));
  const flutter = join(root, "flutter");
  mkdirSync(flutter);
  writeFileSync(join(flutter, "pubspec.yaml"), "name: x");
  await assert.rejects(findProject(flutter), (e: unknown) => e instanceof ToolError && /Flutter/.test(e.message) && /flutter build ios --simulator/.test(e.next ?? ""));
  const cap = join(root, "cap");
  mkdirSync(cap);
  writeFileSync(join(cap, "capacitor.config.ts"), "");
  await assert.rejects(findProject(cap), (e: unknown) => e instanceof ToolError && /Capacitor/.test(e.message) && /npx cap sync ios/.test(e.next ?? ""));
  await assert.rejects(findProject(join(root, "missing")), /does not exist/);
  const empty = join(root, "empty");
  mkdirSync(empty);
  await assert.rejects(findProject(empty), /No Xcode project/);
});

test("an XcodeGen project is regenerated before each build; when that fails, the existing project is built and the call says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "simulator-use-xcodegen-"));
  // A spec xcodegen can't read (or no xcodegen at all, as on Linux): the regeneration fails either way.
  const app = join(root, "app");
  mkdirSync(join(app, "App.xcodeproj"), { recursive: true });
  writeFileSync(join(app, "project.yml"), "name: [\n");
  const found = await findProject(app);
  assert.equal(found.name, "App");
  assert.match(found.note ?? "", /could not regenerate the project from project\.yml .*so the existing project was built/);
  const direct = await findProject(join(app, "App.xcodeproj"));
  assert.match(direct.note ?? "", /could not regenerate/);
  // With no project yet there is nothing to fall back on.
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  writeFileSync(join(fresh, "project.yml"), "name: [\n");
  await assert.rejects(findProject(fresh), (e: unknown) => e instanceof ToolError && /XcodeGen spec \(project\.yml\) but no project/.test(e.message));
  // A workspace (CocoaPods) is never regenerated.
  const pods = join(root, "pods");
  mkdirSync(join(pods, "App.xcworkspace"), { recursive: true });
  writeFileSync(join(pods, "project.yml"), "name: [\n");
  assert.equal((await findProject(pods)).note, undefined);
});

test("a job answers when done, reports progress meanwhile, and says stopped when cancelled", async (t) => {
  // waitFor's timer never holds the process open, and this job is a bare promise; a real job holds it with its
  // child process. Node 22 ends a test whose event loop runs empty, so the test holds it open itself.
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));
  let release!: () => void;
  const job = startJob("Slow work", async (p) => {
    p.step("working");
    p.line("halfway");
    let stopped = false;
    p.setCancel(() => {
      stopped = true;
      release();
    });
    await new Promise<void>((r) => (release = r));
    return { text: stopped ? "killed" : "done" };
  });
  assert.equal(await waitFor(job, 20), undefined);
  assert.equal(job.step, "working");
  assert.deepEqual(job.tail, ["halfway"]);
  assert.equal(getJob(), job, "the latest job is the default");
  job.cancel!();
  const result = await waitFor(job, 1000);
  assert.match(result!.text, /^Slow work was stopped by job_cancel after \d+ s\.$/);
  assert.equal(result!.isError, true);

  const quick = startJob("Quick", async () => ({ text: "ok" }));
  assert.deepEqual(await waitFor(quick, 1000), { text: "ok" });
  const failing = startJob("Failing", async () => {
    throw new ToolError("No scheme.", "Pass scheme.");
  });
  assert.deepEqual(await waitFor(failing, 1000), { text: "No scheme.\nNext: Pass scheme.", isError: true });
});

test("test failures from Xcode's result bundle: the test, ready for -only-testing, and file:line with its message", async () => {
  const { failuresIn, locate } = await import("../src/engine/xcresult.ts");
  const { readFileSync } = await import("node:fs");
  const tests = JSON.parse(readFileSync(new URL("fixtures/xcresult-tests-failed.json", import.meta.url), "utf8"));
  assert.deepEqual(failuresIn(tests.testNodes), [
    { test: "DemoTests/rejectsAnEmailWithoutAt()", id: "rejectsAnEmailWithoutAt()", message: 'SignInTests.swift:18: Expectation failed: (signInMessage(email: "gary@x", password: "secret1") → "Welcome, gary@x") == "Invalid email or password"' },
    { test: "DemoTests/SignInTests/testRejectsAShortPassword()", id: "SignInTests/testRejectsAShortPassword()", message: 'SignInTests.swift:12: XCTAssertEqual failed: ("Welcome, gary@example.com") is not equal to ("Invalid email or password")' },
  ]);
  // The file name becomes its path in the project when it is unique there.
  const sample = new URL("../examples/swiftui-demo", import.meta.url).pathname;
  assert.equal(locate("SignInTests.swift:12: XCTAssertEqual failed", sample), "Tests/SignInTests.swift:12: XCTAssertEqual failed");
  assert.equal(locate("Nowhere.swift:3: boom", sample), "Nowhere.swift:3: boom");
  assert.equal(locate("no file here", sample), "no file here");
});

test("Xcode 27 keeps a failure's place in the test's details: it is found there", async () => {
  const { sourceLocation } = await import("../src/engine/xcresult.ts");
  // The shape of `xcresulttool get test-results test-details` on Xcode 27.0 (October 19, 2026).
  const runs = [{ nodeType: "Device", children: [{ nodeType: "Test Plan Configuration", children: [{ nodeType: "Test Case Run", name: "XCTAssertEqual failed", sourceLocation: { filePath: "/tmp/failing/Tests/SignInTests.swift", lineNumber: 12 } }] }] }];
  assert.deepEqual(sourceLocation(runs), { filePath: "/tmp/failing/Tests/SignInTests.swift", lineNumber: 12 });
  assert.equal(sourceLocation([{ nodeType: "Device" }]), undefined);
});

test("a build failure with a known cause says the fix: an xcconfig kept as a template, a full disk, packages not fetched", () => {
  const root = mkdtempSync(join(tmpdir(), "dl-fix-"));
  writeFileSync(join(root, "App.xcconfig.template"), "TOKEN = ");
  const missing = { severity: "error" as const, message: `Unable to open base configuration reference file '${join(root, "App.xcconfig")}'.` };
  assert.match(knownFix([missing], []) ?? "", /copy App\.xcconfig\.template to App\.xcconfig/);
  const noTemplate = { severity: "error" as const, message: `Unable to open base configuration reference file '${join(root, "Other.xcconfig")}'.` };
  assert.match(knownFix([noTemplate], []) ?? "", /expects Other\.xcconfig/);
  assert.match(knownFix([], ["ld: write() failed, errno=28 (No space left on device) for '/x'"]) ?? "", /disk is full/);
  assert.match(knownFix([{ severity: "error", message: "Could not resolve package dependencies:" }], []) ?? "", /Swift packages/);
  assert.equal(knownFix([{ severity: "error", message: "cannot find 'foo' in scope" }], []), undefined);
});

test("builds run under the host's clamp when one is set, and as plain xcodebuild otherwise", () => {
  const saved = process.env.SIMULATOR_USE_BUILD_CLAMP;
  try {
    delete process.env.SIMULATOR_USE_BUILD_CLAMP;
    assert.deepEqual(buildCommand(["-scheme", "App", "build"]), ["xcodebuild", ["-scheme", "App", "build"]]);
    process.env.SIMULATOR_USE_BUILD_CLAMP = "utility";
    assert.deepEqual(buildCommand(["-scheme", "App", "build"]), ["/usr/sbin/taskpolicy", ["-c", "utility", "xcodebuild", "-scheme", "App", "build"]]);
    process.env.SIMULATOR_USE_BUILD_CLAMP = "maintenance; rm -rf /";
    assert.deepEqual(buildCommand(["build"]), ["xcodebuild", ["build"]]);
  } finally {
    if (saved === undefined) delete process.env.SIMULATOR_USE_BUILD_CLAMP;
    else process.env.SIMULATOR_USE_BUILD_CLAMP = saved;
  }
});

test("versions compare by their numbers", () => {
  assert.equal(laterVersion("27.1", "27.0"), true);
  assert.equal(laterVersion("27.0.1", "27.0"), true);
  assert.equal(laterVersion("27.0", "27.0.0"), false);
  assert.equal(laterVersion("26.10", "26.9"), true);
  assert.equal(laterVersion("26.5", "27.0"), false);
  assert.equal(laterVersion("$(inherited)", "27.0"), false);
});

const tools = process.platform === "darwin" && ["xcodebuild", "xcodegen"].every((t) => spawnSync("/usr/bin/which", [t]).status === 0);
test("a project that targets a later iOS than the phone says so, and how to fix it", { skip: !tools }, async () => {
  // Xcode leaves such a phone out of its destinations without a word: an iOS 26.5 phone and a target of 26.5.1
  // (inside Xcode 26.5's range) gave only "Unable to find a destination matching" (October 24).
  const dir = mkdtempSync(join(tmpdir(), "dl-target-"));
  mkdirSync(join(dir, "Sources"));
  writeFileSync(join(dir, "Sources/App.swift"), "import SwiftUI\n@main struct TargetApp: App { var body: some Scene { WindowGroup { Text(\"Hi\") } } }\n");
  writeFileSync(join(dir, "project.yml"), "name: Target\ntargets:\n  Target:\n    type: application\n    platform: iOS\n    deploymentTarget: \"26.5.1\"\n    sources: [Sources]\n    settings:\n      GENERATE_INFOPLIST_FILE: YES\n      PRODUCT_BUNDLE_IDENTIFIER: test.target\n");
  assert.equal(spawnSync("xcodegen", ["generate"], { cwd: dir }).status, 0);
  const project = await findProject(join(dir, "Target.xcodeproj"));
  assert.equal(await deploymentTarget(project, "Target"), "26.5.1");
  assert.equal(await targetTooNew(project, "Target", { name: "iPhone 17", runtime: "iOS 26.5" }, "app_run again"),
    "Target targets iOS 26.5.1 (its deployment target) and iPhone 17 runs iOS 26.5, so Xcode has no destination for it.\nNext: lower the deployment target to iOS 26.5 or earlier (IPHONEOS_DEPLOYMENT_TARGET; in Xcode, the target's General > Minimum Deployments), then app_run again.");
  assert.equal(await targetTooNew(project, "Target", { name: "iPhone 17", runtime: "iOS 26.6" }, "app_run again"), undefined);
  assert.equal(await targetTooNew(project, "Target", { name: "Apple TV", runtime: "tvOS 26.5" }, "app_run again"), undefined);
});
