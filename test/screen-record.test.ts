import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ToolError } from "../src/errors.ts";
import { screenRecord } from "../src/tools/screen-record.ts";

// What simctl 27 wrote, word for word, when NoMac's replay held a phone's screen (November 7, 2026).
const BUSY = [
  "Note: No display specified. Defaulting to display: 89F600E8-F68C-4BA3-993B-3DCF43F6B209 (screenID: 1, name: LCD)",
  'Error starting video recorder: Error Domain=NSPOSIXErrorDomain Code=16 "Resource busy" UserInfo={NSLocalizedFailureReason=Host recording is already in progress}.',
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=16):",
  "The operation couldn’t be completed. Host recording is already in progress",
  "Host recording is already in progress",
  "",
].join("\n");

test("simctl's reason a recording did not start is its last line, without the display note or the error's domain", async () => {
  const { recorderSaid } = await import("../src/tools/screen-record.ts");
  assert.equal(recorderSaid(BUSY), "Host recording is already in progress");
  assert.equal(recorderSaid("An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown\n"), "Unable to lookup in current state: Shutdown");
  assert.equal(recorderSaid("Note: No display specified. Defaulting to display: X\nRecording started\n"), undefined);
  assert.equal(recorderSaid(""), undefined);
});

// The tool itself, with simctl stood in for: its device list (booted, or shut down once the recorder ran) and a
// recorder that says what it was given and ends at once.
test("a recording that did not start says simctl's reason; the boot hint only for a Simulator no longer booted", { skip: process.platform !== "darwin" }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "su-record-"));
  const udid = "5E55E550-0000-4000-8000-00000000AEC0";
  const list = (state: string) => JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid, name: "iPhone 17 Pro", state, isAvailable: true }] } });
  writeFileSync(join(bin, "booted.json"), list("Booted"));
  writeFileSync(join(bin, "shutdown.json"), list("Shutdown"));
  writeFileSync(join(bin, "xcrun"), [
    "#!/bin/sh",
    `d="${bin}"`,
    'if [ "$2" = list ]; then if [ -f "$d/down" ]; then cat "$d/shutdown.json"; else cat "$d/booted.json"; fi; exit 0; fi',
    'if [ "$2" = io ]; then cat "$d/said" >&2; [ -f "$d/shut-on-record" ] && touch "$d/down"; exit 1; fi',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, STATE: process.env.SIMULATOR_USE_STATE_DIR };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-record-state-"));
  const start = async () => {
    try {
      await screenRecord.run({ action: "start" }, { waitForJobs: true });
    } catch (error) {
      assert.ok(error instanceof ToolError, String(error));
      return error.toText();
    }
    assert.fail("the recording started");
  };
  try {
    // Another recorder holds the screen: simctl's own words, and no boot hint for a Simulator that is booted.
    writeFileSync(join(bin, "said"), BUSY);
    const busy = await start();
    assert.match(busy, /^The recording did not start: simctl says "Host recording is already in progress"\. Another recorder holds iPhone 17 Pro's screen, which takes one recording at a time\.\nNext: Stop that recording/);
    assert.doesNotMatch(busy, /booted|device_use|domain=/);

    // Any other reason is said as simctl said it.
    writeFileSync(join(bin, "said"), "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=164):\nThe file could not be written\n");
    assert.equal(await start(), 'The recording did not start: simctl says "The file could not be written".');

    // The Simulator was shut down meanwhile: then the answer is to boot it.
    writeFileSync(join(bin, "said"), "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown\n");
    writeFileSync(join(bin, "shut-on-record"), "");
    assert.equal(await start(), `The recording did not start: iPhone 17 Pro is not booted.\nNext: Call device_use {device: "${udid}"} to boot it.`);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.STATE === undefined) delete process.env.SIMULATOR_USE_STATE_DIR;
    else process.env.SIMULATOR_USE_STATE_DIR = saved.STATE;
    rmSync(bin, { recursive: true, force: true });
  }
});
