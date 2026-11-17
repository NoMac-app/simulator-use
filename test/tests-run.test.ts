import assert from "node:assert/strict";
import { test } from "node:test";

import { testArgs } from "../src/tools/tests-run.ts";

test("tests run on the phone the tools use, never on clones xcodebuild makes of it", () => {
  // A test target the project runs in parallel (scheme, test plan or XcodeGen spec; Xcode's app template makes its UI
  // tests so) has xcodebuild shut the phone down, clone it and test on the clones; the phone stays off after the run
  // (NoMac, November 14, 2026; on us2, November 17: tests_run's own command cloned until this flag was in it).
  const args = testArgs("/tmp/r.xcresult", []);
  const at = args.indexOf("-parallel-testing-enabled");
  assert.ok(at >= 0, "parallel testing is turned off");
  assert.equal(args[at + 1], "NO");
});

test("the result bundle, no diagnostics and only the tests asked for, as before", () => {
  const args = testArgs("/tmp/r.xcresult", ["DemoTests/SignInTests", "DemoUITests/LaunchTests/testLaunch"]);
  assert.deepEqual(args.slice(args.indexOf("-resultBundlePath"), args.indexOf("-resultBundlePath") + 2), ["-resultBundlePath", "/tmp/r.xcresult"]);
  assert.deepEqual(args.slice(args.indexOf("-collect-test-diagnostics"), args.indexOf("-collect-test-diagnostics") + 2), ["-collect-test-diagnostics", "never"]);
  assert.deepEqual(args.filter((a) => a.startsWith("-only-testing:")), ["-only-testing:DemoTests/SignInTests", "-only-testing:DemoUITests/LaunchTests/testLaunch"]);
});
