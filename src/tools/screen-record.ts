import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isOurs } from "../engine/exec.ts";
import { flattenFmp4 } from "../engine/fmp4.ts";
import { enginePath } from "../engine/native.ts";
import { type Device, listDevices, pickDevice } from "../engine/simctl.ts";
import { deviceDir, heldDevice } from "../engine/state.ts";
import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import type { Tool } from "./types.ts";

/** A recording: simctl's, or on a NoMac phone the engine's stream (engine), written to part until its stop. */
type Recording = { pid: number; file: string; started: number; watchdog?: number; engine?: true; part?: string };

const MAX_SECONDS = 600;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * What simctl said when its recorder ended before it started: its last line, never the display note or the error's
 * domain ("Host recording is already in progress" when another recorder holds the screen).
 */
export function recorderSaid(output: string): string | undefined {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line && !/^(Note:|Recording started)/.test(line));
  return lines.at(-1)?.replace(/\.$/, "");
}

/** Why a recording did not start: simctl's own reason, and the boot hint only for a Simulator no longer booted. */
async function notStarted(device: Device, output: string): Promise<ToolError> {
  const now = await listDevices(true).then((list) => list.find((d) => d.udid === device.udid), () => device);
  if (!now?.booted) return new ToolError(`The recording did not start: ${device.name} is not booted.`, `Call device_use {device: "${device.udid}"} to boot it.`);
  const said = recorderSaid(output);
  if (said && /recording is already in progress/i.test(said)) {
    return new ToolError(`The recording did not start: simctl says "${said}". Another recorder holds ${device.name}'s screen, which takes one recording at a time.`, "Stop that recording (a screen_record started elsewhere, xcrun simctl io recordVideo, or the Simulator's File > Record Screen), then start again.");
  }
  return new ToolError(said ? `The recording did not start: simctl says "${said}".` : "The recording did not start: simctl ended without saying why.");
}

// ---- On a NoMac phone ---------------------------------------------------------------------------------------

/**
 * The engine's stream of the screen, as NoMac's live view takes it (--no-bootstrap: no automation session, so the
 * session's own engine is never wedged), at the screen's own size: H.264 as fragmented MP4, a fragment a frame, so
 * the file is whole up to its last frame whenever the recorder ends. The engine stops it by itself after
 * MAX_SECONDS, then ends (its input is closed). What it answers goes to log. Tests replace it.
 */
let streamScreen = async (udid: string, file: string, log: string): Promise<number | undefined> => {
  const engine = enginePath();
  if (!engine) return undefined;
  const out = openSync(log, "w");
  const child = spawn(engine, ["--udid", udid, "--no-bootstrap"], { detached: true, stdio: ["pipe", out, "ignore"] });
  closeSync(out);
  child.on("error", () => undefined);
  child.stdin!.end(`${JSON.stringify({ id: 1, op: "stream", codec: "h264", transport: "fmp4", fps: 30, scale: 1, bitrate: 2_000_000, keyframe_s: 2, seconds: MAX_SECONDS, path: file })}\n`);
  child.unref();
  return child.pid;
};
export function setScreenStreamer(stream: typeof streamScreen) {
  streamScreen = stream;
}

const STREAM_START_MS = 8_000;
const ENGINE = /simulator-use-engine --udid \S+ --no-bootstrap/;

/**
 * Starts the engine's recording, answering once the engine is ready and still streaming a moment later, or why it
 * is not: its first line says ready (or why not), and a stream that cannot start answers ok: false, and the engine ends.
 */
async function startStream(device: Device, dir: string, file: string): Promise<Recording> {
  const part = file.replace(/\.mp4$/, ".fmp4"), log = join(dir, "recording.log");
  const pid = await streamScreen(device.udid, part, log);
  if (!pid) throw new ToolError("The recording did not start: this phone's screen recorder is missing.");
  const said = () => readFile(log, "utf8").catch(() => "");
  const failed = (text: string) => /"(?:ok|ready)"\s*:\s*false/.test(text);
  const fail = async (text: string, fallback: string, next?: string) => {
    if (alive(pid)) process.kill(pid, "SIGTERM");
    await rm(part, { force: true });
    const reason = /"error"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
    return new ToolError(reason ? `The recording did not start: ${(JSON.parse(reason) as string).replace(/\.$/, "")}.` : fallback, next);
  };
  for (const deadline = Date.now() + STREAM_START_MS; ;) {
    await sleep(150);
    const text = await said();
    if (!alive(pid) || failed(text)) throw await fail(text, "The recording did not start: its recorder ended without saying why.");
    if (/"ready"\s*:\s*true/.test(text)) {
      await sleep(300);
      const later = await said();
      if (!alive(pid) || failed(later)) throw await fail(later, "The recording did not start: its recorder ended without saying why.");
      return { pid, file, part, started: Date.now(), engine: true };
    }
    if (Date.now() > deadline) throw await fail("", "The recording did not start: its recorder was not ready in time.", "Try again in a few seconds.");
  }
}

/** Ends the engine's recording (a signal ends the engine at once, every frame written kept) and makes its MP4. */
async function stopStream(recording: Recording, running: boolean): Promise<{ text: string }> {
  if (running) {
    process.kill(recording.pid, "SIGTERM");
    for (let i = 0; i < 40 && alive(recording.pid); i++) await sleep(125);
    if (alive(recording.pid)) process.kill(recording.pid, "SIGKILL");
  }
  const part = recording.part!;
  if (!existsSync(part) || statSync(part).size === 0) {
    await rm(part, { force: true });
    throw new ToolError("The recording stopped but left no video: its recorder wrote nothing.", 'Start again with screen_record {action: "start"}.');
  }
  let seconds = Math.round((Date.now() - recording.started) / 1000);
  try {
    seconds = Math.round((await flattenFmp4(part, recording.file)).seconds);
    await rm(part, { force: true });
  } catch {
    // Kept as it is: ffmpeg's players and Chrome play it, though QuickTime does not.
    await rename(part, recording.file);
  }
  const mb = (statSync(recording.file).size / 1_000_000).toFixed(1);
  if (running) return { text: `Recorded ${seconds} s (${mb} MB): ${recording.file}` };
  // It ran out its 10 minutes, or its recorder ended before (the phone's screen went away).
  return Date.now() - recording.started >= (MAX_SECONDS - 5) * 1000
    ? { text: `The recording had already stopped after ${MAX_SECONDS / 60} minutes: ${recording.file}` }
    : { text: `The recording had stopped after ${seconds} s, when its recorder ended (${mb} MB): ${recording.file}` };
}

export const screenRecord: Tool = {
  name: "screen_record",
  title: "Record the screen",
  description: "Start or stop a video of the Simulator's screen. stop answers with the MP4 file, to show a person what happened.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "stop"], description: "start or stop" },
      device: { type: "string", description: "Name or UDID; default: the one in use" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  command: "record",
  positional: ["action"],
  async run(args) {
    const device = pickDevice(await listDevices(), args.device as string | undefined, heldDevice());
    const dir = await deviceDir(device.udid);
    const state = join(dir, "recording.json");
    const current = await readFile(state, "utf8").then((t) => JSON.parse(t) as Recording, () => undefined);
    const running = current && (await isOurs(current.pid, current.engine ? ENGINE : /recordVideo/)) ? current : undefined;

    if (args.action === "start") {
      if (running) throw new ToolError(`Already recording since ${new Date(running.started).toLocaleTimeString()} to ${running.file}.`, 'Call screen_record {action: "stop"} first.');
      const file = join(dir, `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
      // On a NoMac phone the session's replay holds simctl's one recorder from the hand-over: the engine records.
      if (setting("HOSTED")) {
        // A recording that ran out its 10 minutes and was never stopped: a new one starts anew.
        if (current?.part) await rm(current.part, { force: true });
        await writeFile(state, JSON.stringify(await startStream(device, dir, file)));
        return { text: `Recording ${device.name} (it stops by itself after ${MAX_SECONDS / 60} minutes). Do the work, then screen_record {action: "stop"} for the file.` };
      }
      // simctl records until it is interrupted; it runs on its own so the call can return. What it says goes to a
      // file, which outlives this process (a pipe would not), so a recorder that ends at once says why.
      const log = join(dir, "recording.log");
      const said = openSync(log, "w");
      let failed = "";
      const child = spawn("xcrun", ["simctl", "io", device.udid, "recordVideo", "--codec=h264", "--force", file], { detached: true, stdio: ["ignore", "ignore", said] });
      closeSync(said);
      child.on("error", (error) => (failed = error.message));
      child.unref();
      await sleep(800);
      if (!child.pid || !alive(child.pid)) throw await notStarted(device, `${await readFile(log, "utf8").catch(() => "")}\n${failed}`);
      // A forgotten recording grows about 13 MB a minute: it ends itself after 10 minutes, the file intact.
      // The watchdog checks the pid is still simctl recording, so a reused pid is never signalled.
      const watchdog = spawn("sh", ["-c", `sleep ${MAX_SECONDS}; ps -p ${child.pid} -o command= | grep -q recordVideo && kill -INT ${child.pid}`], { detached: true, stdio: "ignore" });
      watchdog.unref();
      await writeFile(state, JSON.stringify({ pid: child.pid, file, started: Date.now(), watchdog: watchdog.pid } satisfies Recording));
      return { text: `Recording ${device.name} (it stops by itself after ${MAX_SECONDS / 60} minutes). Do the work, then screen_record {action: "stop"} for the file.` };
    }

    if (current?.engine) {
      try {
        return await stopStream(current, Boolean(running));
      } finally {
        await Promise.all([rm(state, { force: true }), rm(join(dir, "recording.log"), { force: true })]);
      }
    }
    if (!running) {
      await rm(state, { force: true });
      // It ran out its 10 minutes: the file is there all the same.
      if (current && existsSync(current.file)) return { text: `The recording had already stopped after ${MAX_SECONDS / 60} minutes: ${current.file}` };
      throw new ToolError("Nothing is recording on this Simulator.", 'Start with screen_record {action: "start"}.');
    }
    // An interrupt makes simctl finish the file properly; a kill would leave it unplayable.
    process.kill(running.pid, "SIGINT");
    if (running.watchdog && (await isOurs(running.watchdog, /sleep \d+; ps -p/))) process.kill(-running.watchdog);
    for (let i = 0; i < 40 && alive(running.pid); i++) await sleep(250);
    await Promise.all([rm(state, { force: true }), rm(join(dir, "recording.log"), { force: true })]);
    if (!existsSync(running.file)) throw new ToolError("The recording stopped but left no file.");
    const seconds = Math.round((Date.now() - running.started) / 1000);
    const mb = (statSync(running.file).size / 1_000_000).toFixed(1);
    return { text: `Recorded ${seconds} s (${mb} MB): ${running.file}` };
  },
};
