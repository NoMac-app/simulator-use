import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ToolError } from "../src/errors.ts";
import { screenRecord } from "../src/tools/screen-record.ts";
import { fmp4, initSegment, numbers, path as boxPath, readBoxes } from "./fixtures/fmp4.ts";

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

// On a NoMac phone the session's replay holds simctl's one recorder from the hand-over (November 7, 2026), so the
// recording is the engine's stream of the screen (fragmented MP4), made a plain MP4 at its stop: a file the phone's
// answer names while the phone keeps running. The engine and simctl's device list are stood in for.
test("on a NoMac phone, a recording is the engine's stream, made a plain MP4 at its stop", { skip: process.platform !== "darwin" }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "su-record-hosted-"));
  const udid = "5E55E550-0000-4000-8000-00000000AEC1";
  writeFileSync(join(bin, "xcrun"), [
    "#!/bin/sh",
    `if [ "$2" = list ]; then echo '${JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-2": [{ udid, name: "iPhone 17 Pro", state: "Booted", isAvailable: true }] } })}'; exit 0; fi`,
    // simctl's recorder must never run here: the replay holds it.
    'if [ "$2" = io ]; then touch "$(dirname "$0")/simctl-recorded"; exit 1; fi',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const frames = Array.from({ length: 90 }, (_, i) => ({ size: 200 + i, duration: 3000, sync: i % 60 === 0 }));
  writeFileSync(join(bin, "recording.fmp4"), fmp4(frames));
  const keys = ["PATH", "SIMULATOR_USE_STATE_DIR", "SIMULATOR_USE_HOSTED", "SIMULATOR_USE_ENGINE", "FAKE_STREAM", "FAKE_STREAM_FILE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const state = mkdtempSync(join(tmpdir(), "su-record-hosted-state-"));
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, SIMULATOR_USE_STATE_DIR: state, SIMULATOR_USE_HOSTED: "1",
    SIMULATOR_USE_ENGINE: new URL("fixtures/stream-engine/simulator-use-engine", import.meta.url).pathname, FAKE_STREAM: "ok", FAKE_STREAM_FILE: join(bin, "recording.fmp4") });
  const call = async (action: string) => {
    try {
      return { text: (await screenRecord.run({ action }, { waitForJobs: true })).text };
    } catch (error) {
      assert.ok(error instanceof ToolError, String(error));
      return { error: error.toText() };
    }
  };
  const folder = join(state, udid);
  try {
    // The device list is cached: read afresh from the stand-in.
    await (await import("../src/engine/simctl.ts")).listDevices(true);
    const started = await call("start");
    assert.deepEqual(started, { text: 'Recording iPhone 17 Pro (it stops by itself after 10 minutes). Do the work, then screen_record {action: "stop"} for the file.' });
    const recording = JSON.parse(readFileSync(join(folder, "recording.json"), "utf8"));
    assert.equal(recording.engine, true);
    assert.match(recording.part, /\/recording-[\dT-]+Z\.fmp4$/);
    assert.match((await call("start")).error ?? "", /^Already recording since .+\nNext: Call screen_record \{action: "stop"\} first\.$/);

    const stopped = await call("stop");
    const file = /: (\/\S+\.mp4)$/.exec(stopped.text ?? "")?.[1];
    assert.match(stopped.text ?? "", /^Recorded 3 s \(0\.\d MB\): \/\S+\/recording-[\dT-]+Z\.mp4$/);
    // The plain MP4 is there, every frame indexed; the stream's part, the state and the engine's log are gone.
    const boxes = readBoxes(readFileSync(file!));
    assert.deepEqual(boxes.map((b) => b.type), ["ftyp", "moov", "mdat"]);
    assert.deepEqual(numbers(boxPath(boxes, "moov", "trak", "mdia", "minf", "stbl", "stss")), [2, 1, 61]);
    assert.deepEqual(readdirSync(folder).sort(), [file!.split("/").at(-1)]);
    assert.equal((await call("stop")).error, 'Nothing is recording on this Simulator.\nNext: Start with screen_record {action: "start"}.');
    assert.equal(existsSync(join(bin, "simctl-recorded")), false);

    // A recorder that ended by itself (the phone's screen went away) still leaves its video.
    process.env.FAKE_STREAM = "end:1200";
    assert.ok((await call("start")).text);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.match((await call("stop")).text ?? "", /^The recording had stopped after 3 s, when its recorder ended \(0\.\d MB\): \/\S+\.mp4$/);
    // One that ran out its 10 minutes says so.
    assert.ok((await call("start")).text);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ran = JSON.parse(readFileSync(join(folder, "recording.json"), "utf8"));
    writeFileSync(join(folder, "recording.json"), JSON.stringify({ ...ran, started: Date.now() - 601_000 }));
    assert.match((await call("stop")).text ?? "", /^The recording had already stopped after 10 minutes: \/\S+\.mp4$/);

    // A recorder that cannot start says why, and leaves nothing behind.
    process.env.FAKE_STREAM = "refuse";
    assert.equal((await call("start")).error, "The recording did not start: no framebuffer for this device.");
    process.env.FAKE_STREAM = "fail";
    assert.equal((await call("start")).error, "The recording did not start: The stream could not start.");
    assert.equal(readdirSync(folder).filter((f) => f.endsWith(".fmp4") || f === "recording.json").length, 0);

    // Stopped before its first whole frame (only the movie box written): no video, never an empty MP4.
    process.env.FAKE_STREAM = "ok";
    writeFileSync(join(bin, "init.fmp4"), initSegment());
    process.env.FAKE_STREAM_FILE = join(bin, "init.fmp4");
    assert.ok((await call("start")).text);
    assert.equal((await call("stop")).error, 'The recording stopped but left no video: its recorder wrote nothing.\nNext: Start again with screen_record {action: "start"}.');
    assert.equal(readdirSync(folder).filter((f) => f.endsWith(".fmp4")).length, 0);
    process.env.FAKE_STREAM_FILE = join(bin, "recording.fmp4");

    // The live view's engines run as the same user with the recorder's command line but its marker: a recording
    // whose pid such an engine took over is over, and the view's engine is never signalled.
    const view = spawn(process.env.SIMULATOR_USE_ENGINE!, ["--udid", udid, "--no-bootstrap"], { stdio: ["pipe", "ignore", "ignore"] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const part = join(folder, "recording-2026-11-12T19-00-00-000Z.fmp4");
    writeFileSync(part, fmp4(frames.slice(0, 30)));
    writeFileSync(join(folder, "recording.json"), JSON.stringify({ pid: view.pid, file: part.replace(/\.fmp4$/, ".mp4"), part, marker: "recording-2026-11-12T19-00-00-000Z", started: Date.now() - 20_000, engine: true }));
    assert.match((await call("stop")).text ?? "", /^The recording had stopped after 1 s, when its recorder ended/);
    assert.equal(view.exitCode, null);
    view.kill("SIGKILL");

    // A phone keeps its newest recordings on its disk: a start leaves four and its own. Named in 2099, so they are the
    // newest whenever the test runs, above the recordings it made a moment ago (named for the real time).
    for (let i = 0; i < 6; i++) writeFileSync(join(folder, `recording-2099-01-01T00-0${i}-00-000Z.mp4`), "old");
    assert.ok((await call("start")).text);
    assert.deepEqual(readdirSync(folder).filter((f) => /^recording-2099-.*\.mp4$/.test(f)).sort(), [2, 3, 4, 5].map((i) => `recording-2099-01-01T00-0${i}-00-000Z.mp4`));
    assert.ok((await call("stop")).text);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(bin, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
