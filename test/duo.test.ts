// The iPhone Duo in simulator-use (iphone-duo-plan.md, Phase 1): device picking that never makes the Duo the default
// iPhone, ui_look's first line, device_use's fold and its typed errors, input a fold refused, a local recording of
// the screen in use, and a foldable's replay made one plain movie. The engine is a stand-in
// (fixtures/fake-engine-duo.mjs) and simctl a script on PATH; scripts/duo-lab.sh runs the real thing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { batch } from "../src/engine/axe.ts";
import { closeEngines } from "../src/engine/native.ts";
import { defaultPhone, listDevices, parseDevices, pickDevice, runtimeName } from "../src/engine/simctl.ts";
import { ToolError } from "../src/errors.ts";
import { hosted, replayDir, setReplayRecorder } from "../src/hosted.ts";
import { readScreen, settle } from "../src/look/read.ts";
import { deviceUse, screenWords } from "../src/tools/device-use.ts";
import { screenRecord } from "../src/tools/screen-record.ts";
import { deviceLine } from "../src/tools/ui-look.ts";
import { fragment, initSegment } from "./fixtures/fmp4.ts";

const DUO = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const DUO_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4";
const GENERAL = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
const DUO_UDID = "D0D0D0D0-0000-4000-8000-000000000D00";

const list = (duoState = "Booted", newer = false) => JSON.stringify({
  devices: {
    [GENERAL]: [
      { udid: "A", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
      { udid: "B", name: "iPad Pro 11-inch (M5)", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5" },
    ],
    // A Duo-only runtime that is newer than the general one must still never be the default iPhone.
    [newer ? "com.apple.CoreSimulator.SimRuntime.iOS-27-3-iPhone19-4" : DUO_RUNTIME]: [{ udid: DUO_UDID, name: "iPhone Duo", state: duoState, isAvailable: true, deviceTypeIdentifier: DUO }],
  },
});

test("the Duo's own runtime reads as its iOS; the Duo is foldable and never the default iPhone, even on a newer runtime", () => {
  assert.equal(runtimeName(DUO_RUNTIME), "iOS 27.2");
  assert.equal(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-27-2"), "iOS 27.2");
  for (const newer of [false, true]) {
    const devices = parseDevices(list("Shutdown", newer));
    const duo = devices.find((d) => d.udid === DUO_UDID)!;
    assert.equal(duo.foldable, true);
    assert.equal(duo.dedicatedRuntime, true);
    assert.equal(duo.deviceType, DUO);
    assert.deepEqual(devices.map((d) => d.name), ["iPhone 17 Pro", "iPad Pro 11-inch (M5)", "iPhone Duo"], `newer Duo runtime: ${newer}`);
    assert.equal(devices.find(defaultPhone)?.name, "iPhone 17 Pro");
    assert.equal(defaultPhone(duo), false, "a Duo is never the default iPhone, wherever it sorts");
    // Nothing booted: the suggestion is the ordinary iPhone.
    assert.throws(() => pickDevice(devices), (e: unknown) => e instanceof ToolError && /device_use \{device: "iPhone 17 Pro"\}/.test(e.toText()));
  }
  // A booted Duo is still the one the tools use.
  assert.equal(pickDevice(parseDevices(list("Booted"))).udid, DUO_UDID);
});

test("ui_look's first line names the posture and the screen in use; any other phone's is as before", () => {
  const duo = parseDevices(list()).find((d) => d.udid === DUO_UDID)!;
  assert.equal(deviceLine(duo, { id: 3, role: "inner", width: 2007, height: 2853, scale: 3 }, "open"), "iPhone Duo (iOS 27.2), open: inner screen 669x951");
  assert.equal(deviceLine(duo, { id: 3, role: "inner", width: 2853, height: 2007, scale: 3 }, "book"), "iPhone Duo (iOS 27.2), book: inner screen 951x669");
  assert.equal(deviceLine(duo, { id: 1, role: "outer", width: 1398, height: 2034, scale: 3 }, "closed"), "iPhone Duo (iOS 27.2), closed: outer screen 466x678");
  const phone = parseDevices(list()).find((d) => d.udid === "A")!;
  assert.equal(deviceLine(phone, { id: 1, role: "main", width: 1206, height: 2622, scale: 3 }), "iPhone 17 Pro (iOS 27.2)");
  assert.equal(screenWords(undefined), undefined);
});

/** Runs work with simctl a script on PATH (its device list; it logs its arguments) and the Duo's stand-in engine. */
async function withDuo(env: Record<string, string>, work: () => Promise<void>): Promise<{ requests: Array<Record<string, unknown>>; simctl: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "su-duo-"));
  writeFileSync(join(dir, "list.json"), list("Booted"));
  writeFileSync(join(dir, "requests.jsonl"), "");
  writeFileSync(join(dir, "simctl.log"), "");
  writeFileSync(join(dir, "xcrun"), [
    "#!/bin/sh",
    `echo "$*" >> "${dir}/simctl.log"`,
    `if [ "$2" = list ]; then cat "${dir}/list.json"; exit 0; fi`,
    // recordVideo: a recorder that runs until it is interrupted.
    `if [ "$3" = recordVideo ] || [ "$4" = recordVideo ]; then trap 'exit 0' INT; while :; do sleep 0.1; done; fi`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${dir}:${saved.PATH}`, SIMULATOR_USE_ENGINE: new URL("fixtures/fake-engine-duo.mjs", import.meta.url).pathname,
    FAKE_LOG: join(dir, "requests.jsonl"), SIMULATOR_USE_STATE_DIR: join(dir, "state"), ...env,
  });
  try {
    // simctl's list is cached for a few seconds: this test's own, not the last one's.
    await listDevices(true);
    await work();
  } finally {
    closeEngines();
    process.env = saved;
  }
  const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const simctl = readFileSync(join(dir, "simctl.log"), "utf8").trim().split("\n").filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return { requests, simctl };
}

test("device_use folds an iPhone Duo and answers with the screen in use once the fold is done", async () => {
  const { requests } = await withDuo({ FAKE_POSTURE: "closed" }, async () => {
    const book = await deviceUse.run({ device: "iPhone Duo", fold: "book" }, { waitForJobs: true });
    assert.equal(book.isError, undefined);
    // From closed, book goes by way of open, and the answer says so.
    assert.match(book.text, /^Folded book by way of open in 16\.4 s: the inner screen 951x669 is in use; earlier positions no longer hold\.\nUsing iPhone Duo \(iOS 27\.2/);
    const again = await deviceUse.run({ device: "iPhone Duo", fold: "book" }, { waitForJobs: true });
    assert.match(again.text, /^Already book: the inner screen 951x669 is in use\./);
  });
  assert.deepEqual(requests.filter((r) => r.op === "hinge").map((r) => r.posture), ["book", "book"]);
});

test("each typed fold error says what went wrong and what to do; a phone that does not fold is told so without asking its engine", async () => {
  for (const [code, said] of [["busy", /^The hinge is moving already\./], ["timeout", /^The fold did not finish in time\./], ["boot_changed", /^The Simulator restarted while it folded\./], ["unsupported", /^This Simulator does not fold/]] as const) {
    await withDuo({ FAKE_HINGE: code }, async () => {
      const answer = await deviceUse.run({ device: "iPhone Duo", fold: "closed" }, { waitForJobs: true });
      assert.equal(answer.isError, true, code);
      assert.match(answer.text, said, code);
      assert.match(answer.text, /Next: ui_look to see the screen in use, then try again\./, code);
    });
  }
  const { requests } = await withDuo({}, async () => {
    // An ordinary iPhone, booted: no hinge request reaches any engine.
    const devices = list("Shutdown").replace('"udid":"A","name":"iPhone 17 Pro","state":"Shutdown"', '"udid":"A","name":"iPhone 17 Pro","state":"Booted"');
    writeFileSync(join(process.env.PATH!.split(":")[0]!, "list.json"), devices);
    const answer = await deviceUse.run({ device: "iPhone 17 Pro", fold: "open" }, { waitForJobs: true });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /^iPhone 17 Pro does not fold: only an iPhone Duo does\./);
  });
  assert.ok(!requests.some((r) => r.op === "hinge"));
});

test("ui_look on a Duo reads the screen in use and its posture from the engine", async () => {
  await withDuo({ FAKE_POSTURE: "book" }, async () => {
    const screen = await readScreen(DUO_UDID);
    assert.equal(screen.posture, "book");
    assert.deepEqual(screen.screen, { id: 3, role: "inner", width: 2853, height: 2007, scale: 3, orientation: "landscape" });
  });
});

test("an input a fold refused is never sent again another way: the agent is told to read the screen in use", async () => {
  for (const [mode, said] of [["screen_changed", /^The screen in use changed during the input \(the phone folded\), so the rest of it was not sent\.\nNext: Call ui_look/], ["screen_changing", /^The phone is folding, so the input was not sent\./], ["screen_unknown", /^Which screen is in use cannot be read .*\nNext: Call device_use with fold/]] as const) {
    const { requests, simctl } = await withDuo({ FAKE_INPUT: mode }, async () => {
      await assert.rejects(settle(DUO_UDID, "Demo", { steps: ["tap -x 201 -y 350"] }), (e: unknown) => e instanceof ToolError && said.test(e.toText()));
      await assert.rejects(batch(DUO_UDID, ["tap -x 10 -y 20"]), (e: unknown) => e instanceof ToolError && said.test(e.toText()));
    });
    // One settle_read, one steps: never the tap again through the engine, AXe or anything else.
    assert.deepEqual(requests.map((r) => r.op), ["settle_read", "steps"], mode);
    assert.ok(!simctl.some((line) => /axe|batch/.test(line)), mode);
  }
});

test("a local recording of a Duo records the screen in use (simctl needs --display on a phone with two screens)", { skip: process.platform !== "darwin" }, async () => {
  const { simctl } = await withDuo({ FAKE_POSTURE: "closed" }, async () => {
    const started = await screenRecord.run({ action: "start", device: "iPhone Duo" }, { waitForJobs: true });
    assert.match(started.text, /^Recording iPhone Duo's outer screen \(a fold is not followed\)/);
    await screenRecord.run({ action: "stop", device: "iPhone Duo" }, { waitForJobs: true }).catch(() => undefined);
  });
  const record = simctl.find((line) => line.includes("recordVideo"));
  assert.match(record ?? "", /recordVideo --codec=h264 --display=1 --force /);
});

test("a foldable's replay, recorded by the engine as fragmented MP4, is left as one plain movie", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-duo-replay-"));
  const part = join(dir, "fragmented.mp4");
  const frames = [{ size: 900, duration: 3000, sync: true }, { size: 300, duration: 3000, sync: false }, { size: 1200, duration: 3000, sync: true }];
  let decode = 0;
  writeFileSync(part, Buffer.concat([initSegment(2852, 2852), ...frames.map((f, i) => { const b = fragment(i, f, decode); decode += f.duration; return b; })]));
  const saved = process.env.SIMULATOR_USE_STATE_DIR;
  process.env.SIMULATOR_USE_STATE_DIR = join(dir, "state");
  mkdirSync(join(dir, "state"), { recursive: true });
  try {
    setReplayRecorder(async (file) => Object.assign(spawn("/bin/sh", ["-c", `trap 'cp "${part}" "${file}"; exit 0' INT; while :; do sleep 0.1; done`], { stdio: "ignore" }), { fragmented: true }));
    await hosted("simulator-use/replay", { op: "start" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const done = (await hosted("simulator-use/replay", { op: "stop" })) as Record<string, unknown>;
    assert.equal(done.video, true);
    const video = readFileSync(join(replayDir(), "video.mp4"));
    const types: string[] = [];
    for (let off = 0; off + 8 <= video.length;) { types.push(video.toString("latin1", off + 4, off + 8)); off += video.readUInt32BE(off); }
    assert.deepEqual(types, ["ftyp", "moov", "mdat"], "one movie box before the frames, no fragments");
    assert.deepEqual(readdirSync(join(dir, "state")).filter((f) => f.startsWith("replay-")), [], "the fragmented file is gone");
  } finally {
    if (saved === undefined) delete process.env.SIMULATOR_USE_STATE_DIR; else process.env.SIMULATOR_USE_STATE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tools offer the Duo within their budgets: device_use's fold, the cloud's iphone-duo", async () => {
  const { TOOLS } = await import("../src/registry.ts");
  const use = TOOLS.find((t) => t.name === "device_use")!;
  const cloud = TOOLS.find((t) => t.name === "cloud")!;
  assert.deepEqual((use.inputSchema.properties.fold as { enum?: string[] }).enum, ["closed", "book", "open"]);
  assert.ok((cloud.inputSchema.properties.device as { enum?: string[] }).enum!.includes("iphone-duo"));
  const tokens = (tool: typeof use) => Math.ceil(JSON.stringify({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }).length / 4);
  assert.ok(tokens(use) <= 300 && tokens(cloud) <= 300, `${tokens(use)}, ${tokens(cloud)}`);
});

test("without an engine (one cannot start while the display report is not steady), device_use folds with AXe's own hinge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-duo-axe-"));
  const axe = join(dir, "axe");
  writeFileSync(axe, `#!/bin/sh\necho "$*" >> "${dir}/axe.log"\necho "Hinge 90°, partially open"\n`, { mode: 0o755 });
  try {
    await withDuo({ SIMULATOR_USE_ENGINE: "off", SIMULATOR_USE_AXE: axe }, async () => {
      const answer = await deviceUse.run({ device: "iPhone Duo", fold: "book" }, { waitForJobs: true });
      assert.equal(answer.isError, undefined, answer.text);
      assert.match(answer.text, /^Folded book in [\d.]+ s \(by AXe; the screen in use may take up to 20 s more to follow\): call ui_look to see it\./);
    });
    assert.equal(readFileSync(join(dir, "axe.log"), "utf8").trim(), `hinge set tabletop --udid ${DUO_UDID}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
