import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { forCommandLine } from "../src/cli.ts";
import { tryLock, withLock } from "../src/engine/lock.ts";
import { pickDevice, type Device } from "../src/engine/simctl.ts";
import { ownStateDir } from "../src/engine/state.ts";
import { toContent } from "../src/registry.ts";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const UDID = "9D8D9A30-91C6-4F72-B1C2-BB4AFEAA89A4";
/** A fresh state folder for one test, so tests never share locks or the held device. */
const fresh = () => mkdtempSync(join(tmpdir(), "simulator-use-test-"));
/** simulator-use's CLI as a child process, the way an agent runs it a command at a time. */
const cli = (state: string, ...args: string[]) =>
  run(process.execPath, [join(ROOT, "test/fixtures/cli-main.ts"), ...args], { env: { ...process.env, SIMULATOR_USE_STATE_DIR: state } }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

test("CLI hints name commands: tools become simulator-use commands, arguments become words and options", () => {
  assert.equal(forCommandLine(`No Simulator is booted.\nNext: Call device_use {device: "iPhone 17 Pro"} to boot iPhone 17 Pro (iOS 27.0).`),
    `No Simulator is booted.\nNext: Call simulator-use use "iPhone 17 Pro" to boot iPhone 17 Pro (iOS 27.0).`);
  assert.equal(forCommandLine(`x\nNext: call device_use {device: "${UDID}"} again in 30 s.`), `x\nNext: call simulator-use use ${UDID} again in 30 s.`);
  assert.equal(forCommandLine('Next: Install it first: app_control {action: "install", app: "path/to/App.app"}.'), "Next: Install it first: simulator-use app install --app path/to/App.app.");
  assert.equal(forCommandLine("Next: if the app just crashed, call app_logs {crashes: true} again in 30 s."), "Next: if the app just crashed, call simulator-use logs --crashes again in 30 s.");
  assert.equal(forCommandLine("Next: Call device_use with the one to use, or pass device."), "Next: Call simulator-use use with the one to use, or pass --device.");
  assert.equal(forCommandLine("Next: Pass app (the bundle id), or launch it with app_control first."), "Next: Pass --app (the bundle id), or launch it with simulator-use app first.");
  assert.equal(forCommandLine("Next: Call devices to see the names and UDIDs on this Mac."), "Next: Call simulator-use devices to see the names and UDIDs on this Mac.");
  assert.equal(forCommandLine('No element matches "x" (4 on screen).\nNext: ui_look without find lists them.'), 'No element matches "x" (4 on screen).\nNext: simulator-use look without find lists them.');
  // Lines that are not hints can hold the app's own text, and stay as they are.
  assert.equal(forCommandLine('button "Call device_use {device: x}" #b @1,2\nNext: pass the test'), 'button "Call device_use {device: x}" #b @1,2\nNext: pass the test');
});

test("simulator-use call answers one line of MCP content, images as base64, errors flagged", () => {
  assert.deepEqual(toContent({ text: "ok" }), { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(toContent({ text: "no", isError: true }), { content: [{ type: "text", text: "no" }], isError: true });
  assert.deepEqual(toContent({ text: "shot", image: { data: Buffer.from("jpg"), mimeType: "image/jpeg" } }).content[1], { type: "image", data: "anBn", mimeType: "image/jpeg" });
});

test("simulator-use call refuses what is not one JSON object, and names an unknown tool, as JSON on stdout", async () => {
  const state = fresh();
  try {
    for (const [args, pattern] of [[["call"], /Usage: simulator-use call/], [["call", "ui_look", "{nope"], /not JSON/], [["call", "ui_look", "[]"], /JSON object/], [["call", "ui_look", "{}", "x"], /one JSON object/]] as const) {
      const out = await cli(state, ...args);
      assert.equal(out.code, 2, args.join(" "));
      const line = JSON.parse(out.stdout) as { content: { text: string }[]; isError: boolean };
      assert.equal(line.isError, true);
      assert.match(line.content[0]!.text, pattern);
    }
    const unknown = await cli(state, "call", "ui_tap", "{}");
    assert.equal(unknown.code, 1);
    assert.match((JSON.parse(unknown.stdout) as { content: { text: string }[] }).content[0]!.text, /No tool named "ui_tap"/);
    // A JSON line per call, nothing else on stdout.
    assert.equal(unknown.stdout.trim().split("\n").length, 1);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("the CLI keeps the Simulator chosen with use in a file, for the next command; MCP keeps it in memory", async () => {
  const state = fresh();
  try {
    const child = (code: string) => run(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, SIMULATOR_USE_STATE_DIR: state }, cwd: ROOT });
    const state_ts = JSON.stringify(join(ROOT, "src/engine/state.ts"));
    await child(`import { persistHeld, holdDevice } from ${state_ts}; persistHeld(); holdDevice("${UDID}");`);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "held-device.json"), "utf8")), { udid: UDID });
    const later = await child(`import { persistHeld, heldDevice } from ${state_ts}; persistHeld(); console.log(heldDevice() ?? "none");`);
    assert.equal(later.stdout.trim(), UDID);
    // An MCP server (no persistHeld) neither reads nor writes it: each agent holds its own device.
    const server = await child(`import { holdDevice, heldDevice } from ${state_ts}; console.log(heldDevice() ?? "none"); holdDevice("00000000-0000-0000-0000-000000000000");`);
    assert.equal(server.stdout.trim(), "none");
    assert.deepEqual(JSON.parse(readFileSync(join(state, "held-device.json"), "utf8")), { udid: UDID });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("a lock is shared across processes, waited for, and taken over from an owner that died", async () => {
  const state = fresh();
  const before = process.env.SIMULATOR_USE_STATE_DIR;
  process.env.SIMULATOR_USE_STATE_DIR = state;
  try {
    // Another process takes the lock and keeps it until it is killed.
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { tryLock } from ${JSON.stringify(join(ROOT, "src/engine/lock.ts"))}; await tryLock("act-${UDID}"); console.log("held"); setInterval(() => {}, 1000);`], {
      env: { ...process.env, SIMULATOR_USE_STATE_DIR: state },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    const taken = await tryLock(`act-${UDID}`);
    assert.deepEqual(taken, { holder: holder.pid });
    // Waiting past its limit says who holds it.
    await assert.rejects(withLock(`act-${UDID}`, 300, (pid) => new Error(`held by ${pid}`), async () => "ran"), new RegExp(`held by ${holder.pid}`));
    // Once its owner is gone, the next caller takes it over.
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    assert.equal(await withLock(`act-${UDID}`, 1_000, () => new Error("still held"), async () => "ran"), "ran");
    // Released after the work: the next taker gets it at once.
    const again = await tryLock(`act-${UDID}`);
    assert.ok("release" in again);
    await again.release();
    // A project path is hashed into a plain lock name.
    const project = await tryLock("project-/Users/agent/drive/src/My App/My App.xcodeproj");
    assert.ok("release" in project);
    await project.release();
  } finally {
    if (before === undefined) delete process.env.SIMULATOR_USE_STATE_DIR;
    else process.env.SIMULATOR_USE_STATE_DIR = before;
    rmSync(state, { recursive: true, force: true });
  }
});

test("with two Simulators booted, a command uses the one chosen earlier with use", () => {
  const device = (udid: string, name: string): Device => ({ udid, name, state: "Booted", runtime: "iOS 27.0", booted: true });
  const both = [device(UDID, "iPhone 18 Pro"), device("9EA57387-4EA5-44FE-93F4-7A526176AB64", "iPhone 17e")];
  assert.equal(pickDevice(both, undefined, UDID).udid, UDID);
  assert.throws(() => pickDevice(both), /2 Simulators are booted/);
});

test("settings: SIMULATOR_USE_* first, then SIMTAP_* as before the rename", async () => {
  const read = (env: Record<string, string>) =>
    run(process.execPath, ["--input-type=module", "-e", `import { stateDir } from ${JSON.stringify(join(ROOT, "src/engine/state.ts"))}; console.log(stateDir());`], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SIMULATOR_USE|SIMTAP)_/.test(k))), ...env },
    }).then((r) => r.stdout.trim());
  assert.equal(await read({ SIMTAP_STATE_DIR: "/tmp/old-name" }), "/tmp/old-name");
  assert.equal(await read({ SIMTAP_STATE_DIR: "/tmp/old-name", SIMULATOR_USE_STATE_DIR: "/tmp/new-name" }), "/tmp/new-name");
  // The default: macOS's own temporary folder, or one named for the user where the temporary folder is shared.
  assert.match(await read({}), process.platform === "darwin" ? /simulator-use$/ : /simulator-use-\d+$/);
});

test("the local state folder is the user's own: named for the user where the temporary folder is shared, 0700, never a link", () => {
  const uid = process.getuid!();
  const base = mkdtempSync(join(tmpdir(), "su-base-"));
  const linux = ownStateDir(base, "linux");
  assert.equal(linux, join(base, `simulator-use-${uid}`));
  assert.equal(statSync(linux).mode & 0o777, 0o700);
  chmodSync(linux, 0o777);
  ownStateDir(base, "linux");
  assert.equal(statSync(linux).mode & 0o777, 0o700, "a folder others could read is closed");
  const mac = ownStateDir(base, "darwin");
  assert.equal(mac, join(base, "simulator-use"), "macOS's temporary folder is the user's already: the name stays");
  const other = mkdtempSync(join(tmpdir(), "su-base-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "su-elsewhere-"));
  symlinkSync(elsewhere, join(other, `simulator-use-${uid}`));
  assert.throws(() => ownStateDir(other, "linux"), /not this user's own folder/);
  assert.ok(lstatSync(join(other, `simulator-use-${uid}`)).isSymbolicLink());
});
