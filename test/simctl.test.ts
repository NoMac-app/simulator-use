import assert from "node:assert/strict";
import { test } from "node:test";

import { NOMAC_URL } from "../src/cloud-hint.ts";
import { type Device, findDevice, listDevices, listError, parseDevices, pickDevice, runtimeName } from "../src/engine/simctl.ts";
import { ToolError } from "../src/errors.ts";

test("runtime identifiers read as people write them", () => {
  assert.equal(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-26-5"), "iOS 26.5");
  assert.equal(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-18-6-1"), "iOS 18.6.1");
  assert.equal(runtimeName("com.apple.CoreSimulator.SimRuntime.xrOS-26-0"), "visionOS 26.0");
  assert.equal(runtimeName("something-else"), "something-else");
});

test("devices: available only, booted first, newest runtime first", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "A", name: "iPhone 16", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { udid: "B", name: "iPhone 17e", state: "Shutdown", isAvailable: true },
        { udid: "C", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
        { udid: "D", name: "iPhone 17 Pro Max", state: "Shutdown", isAvailable: false },
      ],
    },
  });
  assert.deepEqual(
    parseDevices(json).map((d) => `${d.udid} ${d.name} ${d.runtime} ${d.booted}`),
    ["C iPhone 17 Pro iOS 26.5 true", "B iPhone 17e iOS 26.5 false", "A iPhone 16 iOS 18.6 false"],
  );
});

const device = (udid: string, name: string, booted: boolean): Device => ({ udid, name, runtime: "iOS 26.5", booted, state: booted ? "Booted" : "Shutdown" });
const nextStep = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error.toText();
  }
  assert.fail("expected a ToolError");
};

test("picking a device: the only booted one, or the one named", () => {
  const list = [device("U1", "iPhone 17 Pro", true), device("U2", "iPhone 17e", false)];
  assert.equal(pickDevice(list).udid, "U1");
  assert.equal(pickDevice(list, "iphone 17 pro").udid, "U1");
  assert.equal(pickDevice(list, "U1").udid, "U1");
});

test("picking a device: every failure names the next step", () => {
  assert.match(nextStep(() => pickDevice([device("U2", "iPhone 17e", false)])), /No Simulator is booted\.\nNext: Call device_use \{device: "iPhone 17e"\} to boot iPhone 17e/);
  assert.match(nextStep(() => pickDevice([device("U2", "iPhone 17e", false)], "iPhone 17e")), /iPhone 17e \(iOS 26\.5\) is not booted\.\nNext: Call device_use \{device: "U2"\}/);
  assert.match(nextStep(() => pickDevice([], "Pixel")), /No Simulator named "Pixel"\.\nNext: Call devices/);
  assert.match(nextStep(() => pickDevice([device("U1", "A", true), device("U3", "B", true)])), /2 Simulators are booted.*\nNext: Call device_use with the one to use/);
});

test("with several booted, the one this agent holds is used; one it held that was shut down is not", () => {
  const list = [device("U1", "iPhone 17 Pro", true), device("U3", "iPhone 17e", true), device("U4", "iPhone Air", false)];
  assert.equal(pickDevice(list, undefined, "U3").udid, "U3");
  assert.equal(pickDevice(list, "iPhone 17 Pro", "U3").udid, "U1", "a device named in the call wins");
  // Never slide onto another agent's Simulator: say the held one is gone.
  assert.match(nextStep(() => pickDevice(list, undefined, "U4")), /iPhone Air \(iOS 26\.5\), the Simulator this agent was using, is no longer booted\.\nNext: Call device_use \{device: "U4"\}/);
});

test("devices: iPhones before iPads on the same runtime", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
        { udid: "P", name: "iPad Air 11-inch (M4)", state: "Shutdown" },
        { udid: "Q", name: "Apple Vision Pro", state: "Shutdown" },
        { udid: "R", name: "iPhone 17 Pro", state: "Shutdown" },
      ],
    },
  });
  assert.deepEqual(parseDevices(json).map((d) => d.udid), ["R", "P", "Q"]);
});

test("devices: iOS before watchOS, tvOS and visionOS, whatever their names sort as", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "W", name: "Apple Watch Series 11", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.xrOS-26-0": [{ udid: "V", name: "Apple Vision Pro", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "O", name: "iPhone 16", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "N", name: "iPhone 17 Pro", state: "Shutdown" }],
    },
  });
  assert.deepEqual(parseDevices(json).map((d) => d.udid).slice(0, 2), ["N", "O"]);
});

test("where simulator-use can't run, the next step is a cloud phone, then a Mac; SIMULATOR_USE_NO_CLOUD_HINT leaves the phone out", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    delete process.env.SIMULATOR_USE_NO_CLOUD_HINT;
  });
  await assert.rejects(listDevices(true), (e: unknown) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.toText(), /can't run the iOS Simulator/);
    assert.match(e.toText(), /Next: cloud start runs every tool on a NoMac cloud iPhone Simulator, billed per minute \(.+\); then call this again\. Or: run simulator-use on a Mac with Xcode\.$/);
    assert.ok(e.toText().includes(NOMAC_URL));
    return true;
  });
  process.env.SIMULATOR_USE_NO_CLOUD_HINT = "1";
  await assert.rejects(listDevices(true), (e: unknown) => e instanceof ToolError && e.toText().endsWith("Next: Run simulator-use on a Mac with Xcode.") && !e.toText().includes("NoMac"));
});

test("a slow Simulator service is a wait, not a missing Simulator: no pointer elsewhere", () => {
  const slow = listError(new Error("xcrun simctl: timed out after 30 s")).toText();
  assert.match(slow, /did not answer within 30 s/);
  assert.match(slow, /Next: Call again in 30 s\./);
  assert.ok(!slow.includes("NoMac") && !slow.includes("can't run"));
  const missing = listError(new Error("xcrun simctl: spawn xcrun ENOENT")).toText();
  assert.match(missing, /can't run the iOS Simulator/);
});

test("a name with its runtime, as simulator-use prints it, picks that runtime's phone", () => {
  const phone = (udid: string, runtime: string): Device => ({ udid, name: "iPhone 17 Pro", state: "Shutdown", runtime, booted: false });
  const list = [phone("NEW", "iOS 27.0"), phone("OLD", "iOS 26.5")];
  assert.equal(findDevice(list, "iPhone 17 Pro")?.udid, "NEW");
  assert.equal(findDevice(list, "iPhone 17 Pro (iOS 26.5)")?.udid, "OLD");
  assert.equal(findDevice(list, "iphone 17 pro (ios 27.0)")?.udid, "NEW");
  assert.equal(findDevice(list, "iPhone 17 Pro (iOS 25.0)"), undefined);
});
