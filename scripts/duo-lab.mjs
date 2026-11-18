// The iPhone Duo lab (scripts/duo-lab.sh): every posture and every move between them on a real Duo, checked from three
// sides: what simulator-use answers (as an agent uses it), what the engine does (its stream, screen events, recording,
// refusals and timings), and what the app in examples/duo-lab saw (its own log of every touch, key and swipe, read
// from its container), so a tap's target is proven by the app, not by our own read of the screen.
//   node scripts/duo-lab.mjs [--rounds N] [--udid UDID] [--out DIR] [--keep]
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const ROUNDS = Number(arg("rounds", "2"));
const OUT = arg("out", join(root, "duo-lab-out", new Date().toISOString().replace(/[:.]/g, "-")));
const KEEP = process.argv.includes("--keep");
const ENGINE = process.env.SIMULATOR_USE_ENGINE || join(root, "vendor/axe/simulator-use-engine");
const APP = "dev.simtap.duolab";
const DUO_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
// What each posture shows: the screen in use, and the sizes it can be drawn at (points). The guest turns the inner
// screen as the app in front allows (iOS 27.2 drew Settings and this lab's app landscape, 951x669, open and half
// open), so the lab takes the size the engine names and checks everything else against it: the screenshot's pixels
// (3 to a point), simctl's own screenshot of that display, the live stream's size and its screen events.
const EXPECT = {
  closed: { role: "outer", sizes: ["466x678"], id: 1 },
  book: { role: "inner", sizes: ["951x669", "669x951"], id: 3 },
  open: { role: "inner", sizes: ["951x669", "669x951"], id: 3 },
};
const pixelsOf = (points) => points.split("x").map((v) => Number(v) * 3).join("x");
/** The screen a simulator-use answer names: "the inner screen 951x669" or "open: inner screen 951x669". */
const named = (text) => /(outer|inner) screen (\d+x\d+)/.exec(text)?.slice(1) ?? [];
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${String(detail).slice(0, 300)})` : ""}`);
  return Boolean(ok);
}
const timings = {};
const note = (key, value) => { (timings[key] ??= []).push(value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** simulator-use as an agent's command line: its text, whether it said it failed, and how long it took. */
async function su(...args) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await exec("node", [join(root, "bin/simulator-use.js"), ...args], { cwd: root, maxBuffer: 64 << 20, timeout: 180_000 });
    return { text: stdout + stderr, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { text: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`, ok: false, ms: Date.now() - started };
  }
}
const simctl = (...args) => exec("xcrun", ["simctl", ...args], { maxBuffer: 64 << 20, timeout: 120_000 });

/** The engine, spoken to directly: JSON lines on stdin and stdout; stderr's "@nomac " lines are its screen events. */
class Engine {
  constructor(udid, args = [], { video = false } = {}) {
    this.child = spawn(ENGINE, ["--udid", udid, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    this.events = [];
    this.stderrOther = 0;
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      if (line.startsWith("@nomac ")) this.events.push({ at: Date.now(), event: JSON.parse(line.slice(7)) });
      else this.stderrOther++;
    });
    this.video = video;
    this.chunks = [];
    this.waiters = [];
    this.lines = [];
    let pending = Buffer.alloc(0), readyDone = false;
    this.child.stdout.on("data", (chunk) => {
      if (this.video && readyDone) { this.chunks.push({ at: Date.now(), data: chunk }); return; }
      pending = Buffer.concat([pending, chunk]);
      for (let nl = pending.indexOf(10); nl >= 0; nl = pending.indexOf(10)) {
        const line = pending.subarray(0, nl).toString("utf8");
        pending = pending.subarray(nl + 1);
        try { this.lines.push(JSON.parse(line)); } catch { /* not a JSON line */ }
        if (this.video) { readyDone = true; if (pending.length) this.chunks.push({ at: Date.now(), data: pending }); pending = Buffer.alloc(0); break; }
      }
      this.wake();
    });
    this.child.on("exit", () => { this.dead = true; this.wake(); });
    this.n = 0;
  }
  wake() { for (const w of this.waiters.splice(0)) w(); }
  async next(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (!this.lines.length) {
      if (this.dead || Date.now() > until) throw new Error(this.dead ? "the engine stopped" : "no answer in time");
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 200); });
    }
    return this.lines.shift();
  }
  ready(timeoutMs = 60_000) { return this.next(timeoutMs); }
  async call(request, timeoutMs = 60_000) {
    this.child.stdin.write(`${JSON.stringify({ id: ++this.n, ...request })}\n`);
    return this.next(timeoutMs);
  }
  send(request) { this.child.stdin.write(`${JSON.stringify({ id: ++this.n, ...request })}\n`); }
  stop(signal = "SIGTERM") { return new Promise((r) => { if (this.dead) return r(); this.child.once("exit", r); this.child.kill(signal); setTimeout(() => { this.child.kill("SIGKILL"); r(); }, 8_000); }); }
}

/** H.264 Annex B: its units' types, and each SPS's picture size (a minimal SPS reader: enough for these streams). */
function annexB(buffer) {
  const units = [];
  for (let i = 0, start = -1; i + 3 <= buffer.length; i++) {
    const three = buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1;
    if (three || i + 3 === buffer.length) {
      if (start >= 0) units.push(buffer.subarray(start, three ? (buffer[i - 1] === 0 ? i - 1 : i) : buffer.length));
      if (three) { start = i + 3; i += 2; }
    }
  }
  return units.map((u) => ({ type: u[0] & 0x1f, size: u.length, ...(u[0] & 0x1f) === 7 ? { sps: spsSize(u) } : {} }));
}
function spsSize(nal) {
  const bytes = [];
  for (let i = 1; i < nal.length; i++) { if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; bytes.push(nal[i]); }
  let bit = 0;
  const u = (n) => { let v = 0; for (let k = 0; k < n; k++, bit++) v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  const ue = () => { let z = 0; while (u(1) === 0) z++; return (1 << z) - 1 + u(z); };
  const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
  const profile = u(8); u(16); ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = ue(); if (chroma === 3) u(1); ue(); ue(); u(1);
    if (u(1)) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (u(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue(); else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); u(1);
  const w = ue() + 1, h = ue() + 1, frameOnly = u(1);
  if (!frameOnly) u(1);
  u(1);
  let crop = [0, 0, 0, 0];
  if (u(1)) crop = [ue(), ue(), ue(), ue()];
  return `${w * 16 - 2 * (crop[0] + crop[1])}x${(2 - frameOnly) * h * 16 - 2 * (crop[2] + crop[3])}`;
}

/** A PNG's pixel size. */
const pngSize = (file) => { const b = readFileSync(file); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; };
/** Two pictures alike: both scaled to 60x60 by sips, the mean difference of their channels (0 to 255). */
async function difference(a, b) {
  const bmp = async (file) => {
    const out = `${file}.bmp`;
    await exec("sips", ["-z", "60", "60", "-s", "format", "bmp", file, "--out", out]);
    const buf = readFileSync(out);
    const offset = buf.readUInt32LE(10), bpp = buf.readUInt16LE(28) / 8;
    return { buf, offset, bpp };
  };
  const [x, y] = [await bmp(a), await bmp(b)];
  let sum = 0, n = 0;
  for (let i = 0; i < 60 * 60; i++) for (let c = 0; c < 3; c++) { sum += Math.abs(x.buf[x.offset + i * x.bpp + c] - y.buf[y.offset + i * y.bpp + c]); n++; }
  return sum / n;
}

/** The app's own log (Documents/duo-lab.json in its container). */
async function appLog(udid) {
  const { stdout } = await simctl("get_app_container", udid, APP, "data");
  const file = join(stdout.trim(), "Documents", "duo-lab.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Whether a video plays in AVFoundation, and what it shows (scripts/duo-play.swift). */
async function plays(file) {
  const { stdout } = await exec("xcrun", ["swift", join(root, "scripts/duo-play.swift"), file], { timeout: 180_000 });
  return JSON.parse(stdout.trim().split("\n").pop());
}

async function duoRuntime() {
  const { stdout } = await simctl("list", "runtimes", "-j");
  const runtimes = JSON.parse(stdout).runtimes ?? [];
  return runtimes.find((r) => r.isAvailable && (r.supportedDeviceTypes ?? []).some((t) => t.identifier === DUO_TYPE));
}

// ---- The lab -------------------------------------------------------------------------------------------------

let udid = arg("udid");
let created = false;
const runtime = await duoRuntime();
if (!udid) {
  if (!check("a runtime that runs the iPhone Duo is installed", runtime, runtime?.identifier)) process.exit(1);
  udid = (await simctl("create", `duo-lab-${Date.now()}`, DUO_TYPE, runtime.identifier)).stdout.trim();
  created = true;
}
console.log(`Duo ${udid} on ${runtime?.identifier}; results in ${OUT}`);
try {
  // Boot (closed, as a Duo boots) and the first look that reads, with when its picture is real.
  const bootStart = Date.now();
  let boot = await su("use", udid);
  while (!boot.ok && /longer than this call may wait/.test(boot.text) && Date.now() - bootStart < 300_000) boot = await su("use", udid);
  check("boots with device_use", boot.ok, boot.text.split("\n")[0]);
  note("boot_ms", Date.now() - bootStart);
  // Closed, as a Duo boots (a Duo given by --udid may be in any posture).
  await su("use", udid, "--fold", "closed");
  let firstLook;
  for (const until = Date.now() + 180_000; Date.now() < until;) {
    firstLook = await su("look", "--device", udid);
    if (firstLook.ok && /closed: outer screen 466x678/.test(firstLook.text.split("\n")[0])) break;
    await sleep(2_000);
  }
  note("first_look_after_boot_ms", Date.now() - bootStart);
  check("the first look names the closed posture and the outer screen", /closed: outer screen 466x678/.test(firstLook.text.split("\n")[0]), firstLook.text.split("\n")[0]);
  for (const until = Date.now() + 180_000; Date.now() < until; await sleep(2_000)) {
    const shot = join(OUT, "boot-picture.png");
    await simctl("io", udid, "screenshot", "--display=1", shot).catch(() => undefined);
    // A black screen's PNG is a few KB; any real picture (the home screen, an app) is far more.
    if (existsSync(shot) && statSync(shot).size > 60_000) { note("real_picture_after_boot_ms", Date.now() - bootStart); break; }
  }

  // The app.
  const run = await su("run", join(root, "examples/duo-lab"), "--device", udid);
  check("builds, installs and launches the lab app on the Duo", run.ok && /DuoLab|Cell A1/.test(run.text), run.text.split("\n").slice(0, 2).join(" | "));
  note("app_run_ms", run.ms);

  // The engine's ready line (an engine without an automation session, as the live view's are: the agent's own
  // engines, one a command here, open and close theirs).
  const probe = new Engine(udid, ["--no-bootstrap"]);
  const ready = await probe.ready();
  await probe.stop();
  check("the engine's ready line names the screen, posture and normalized input", ready.ready && ready.screen?.role === "outer" && ready.posture === "closed" && ready.input?.includes("normalized"), JSON.stringify({ screen: ready.screen, posture: ready.posture, input: ready.input, screens_ms: ready.screens_ms }));
  note("engine_ready_ms", ready.screens_ms);

  const moves = ["book", "open", "closed", "open", "book", "closed"];
  let posture = "closed";
  let shownSize = "466x678";
  let recorder, recording;
  for (let round = 1; round <= ROUNDS; round++) {
    // Round 1 records every move on the engine's canvas (screen_record's and the replay's path), from start to end.
    if (round === 1) {
      recording = join(OUT, "across-folds.fmp4");
      recorder = new Engine(udid, ["--no-bootstrap", "--recording", "duo-lab"]);
      await recorder.ready();
      recorder.send({ op: "stream", codec: "h264", transport: "fmp4", fps: 30, scale: 1, bitrate: 2_000_000, keyframe_s: 2, seconds: 0, path: recording });
    }
    for (const [index, next] of moves.entries()) {
      const label = `round ${round}, ${posture} to ${next}`;
      // One move a round has a live-view stream running across it (follows the screen, events on stderr), and one a
      // second engine's long drag (input that must be refused when the screen changes under it), and reads meanwhile.
      const streamAcross = index === (round % moves.length);
      const dragAcross = index === ((round + 2) % moves.length) && next !== "book" && posture !== "book";
      let live, liveStart, dragger, dragAnswer, reader, readerAnswers = [];
      if (streamAcross) {
        live = new Engine(udid, ["--no-bootstrap"], { video: true });
        await live.ready();
        liveStart = Date.now();
        live.send({ op: "stream", fd: 1, seconds: 0, fps: 30, scale: 0.5, bitrate: 1_500_000, keyframe_s: 2 });
        await sleep(1_500);
      }
      if (dragAcross) {
        dragger = new Engine(udid, ["--no-bootstrap"]);
        await dragger.ready();
        reader = new Engine(udid, ["--no-bootstrap"]);
        await reader.ready();
        await reader.call({ op: "describe", lean: true });
      }
      const foldStart = Date.now();
      const foldCall = su("use", udid, "--fold", next);
      if (dragger) {
        // A drag from the far left to the right, 25 s long: the screen changes under it.
        await sleep(800);
        const size = shownSize.split("x").map(Number);
        dragAnswer = dragger.call({ op: "drag", x1: 20, y1: size[1] - 60, x2: size[0] - 20, y2: size[1] - 60, duration: 25, steps: 250, hold: 0.05 }, 60_000);
        (async () => { for (const until = Date.now() + 22_000; Date.now() < until;) { readerAnswers.push(await reader.call({ op: "describe", lean: true }, 30_000).catch((e) => ({ ok: false, error: String(e) }))); await sleep(300); } })();
      }
      const fold = await foldCall;
      note(`fold_${posture}_to_${next}_ms`, Date.now() - foldStart);
      const want = EXPECT[next];
      const [role, points] = named(fold.text);
      check(`${label}: device_use folds and names the screen (${role} ${points})`, fold.ok && new RegExp(`^(Folded|Already) ${next}`).test(fold.text) && role === want.role && want.sizes.includes(points), fold.text.split("\n")[0]);
      const before = shownSize;
      shownSize = points ?? shownSize;
      if (dragger) {
        const answer = await dragAnswer;
        check(`${label}: a drag the fold interrupted is refused (screen_changed), its finger lifted`, answer.ok === false && answer.code === "screen_changed" && answer.input_sent === true, JSON.stringify({ ok: answer.ok, code: answer.code, error: answer.error, input_sent: answer.input_sent, screen: answer.screen?.role }));
        await sleep(2_500);
        const consistent = readerAnswers.filter((a) => a.ok).every((a) => {
          const root = Array.isArray(a.tree) ? a.tree[0] : a.tree;
          const f = root?.frame;
          const expected = a.screen && a.screen.width / a.screen.scale;
          return !f || !expected || Math.abs((root.display?.width ?? f.width) - expected) < 2;
        });
        check(`${label}: every read during the fold is of the screen its answer names (${readerAnswers.length} reads)`, readerAnswers.length > 5 && consistent, readerAnswers.map((a) => `${a.screen?.role ?? "?"}${a.screen_changed ? "*" : ""}${a.ok ? "" : "!"}`).join(" "));
        await dragger.stop(); await reader.stop();
      }
      if (live) {
        await sleep(2_500);
        await live.stop();
        const video = Buffer.concat(live.chunks.map((c) => c.data));
        writeFileSync(join(OUT, `live-r${round}-${posture}-to-${next}.h264`), video);
        const units = annexB(video);
        const sizes = [...new Set(units.filter((u) => u.sps).map((u) => u.sps))];
        const frames = units.filter((u) => u.type === 1 || u.type === 5).length;
        const changed = before !== shownSize;
        const event = live.events.at(-1)?.event;
        // The live view's picture: half the screen's pixels, each side even.
        const shown = (p) => p.split("x").map((v) => Math.max(2, Math.floor((Number(v) * 0.5) / 2) * 2)).join("x");
        check(`${label}: the live stream follows the fold (${frames} frames, ${live.events.length} event(s), SPS ${sizes.join(", ")})`,
          frames > 30 * ((Date.now() - liveStart) / 1000) * 0.5 && live.stderrOther === 0 && live.events.length >= 1 &&
          event?.screen?.role === want.role && `${event.screen.width}x${event.screen.height}` === pixelsOf(shownSize) && event.posture === next &&
          (changed ? sizes.length >= 2 && sizes.at(-1) === shown(pixelsOf(shownSize)) : sizes.length === 1),
          JSON.stringify({ events: live.events.map((e) => e.event), sizes, other_stderr: live.stderrOther }));
      }
      posture = next;
      await exercise(label, posture, round);
    }
    if (round === 1 && recorder) {
      await recorder.stop("SIGTERM");
      const flat = join(OUT, "across-folds.mp4");
      const { flattenFmp4 } = await import(join(root, "dist/engine/fmp4.js"));
      const made = await flattenFmp4(recording, flat).catch((e) => ({ error: String(e) }));
      const played = await plays(flat).catch((e) => ({ error: String(e) }));
      // Every sampled frame decodes; most show the screen in use. A few are dark: the frames inside a fold's switch,
      // when the screen the phone still names in use has gone dark (Apple's 27.2 Duo moves its interface seconds later).
      const bright = (played.frames ?? []).filter((f) => f.brightness > 5).length;
      check(`a recording across every move is one movie that plays, on one canvas (${bright} of ${played.frames?.length} sampled frames lit)`, !made.error && played.playable && played.video_tracks === 1 && played.width === 2852 && played.height === 2852 && played.seconds > 60 && played.frames?.length === 20 && bright >= 15 && played.frames[0].brightness > 5 && played.frames[19].brightness > 5,
        JSON.stringify({ made, seconds: played.seconds, size: `${played.width}x${played.height}`, brightness: played.frames?.map((f) => Math.round(f.brightness)) }));
    }
  }

  // Latencies on one engine with its automation session, kept: taps on each screen (the call, and the screen's first
  // change), and whole reads.
  const latency = new Engine(udid);
  await latency.ready();
  for (const p of ["closed", "open"]) {
    await su("use", udid, "--fold", p);
    await su("app", "launch", "--app", APP, "--device", udid);
    await latency.call({ op: "screen" });
    const sends = [], firsts = [], reads = [];
    for (let i = 0; i < 20; i++) {
      // The segmented control: Grid and Tools in turn, each a change of the screen.
      const point = (await latency.call({ op: "describe", lean: true })).tree;
      const segments = [];
      (function walk(n) { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (/^(Grid|Tools)$/.test(n.AXLabel ?? "") && n.frame) segments.push(n); (n.children ?? []).forEach(walk); })(point);
      const target = segments[i % 2] ?? segments[0];
      if (!target) break;
      const t = await latency.call({ op: "tap_trace", x: target.frame.x + target.frame.width / 2, y: target.frame.y + target.frame.height / 2, window_ms: 600 });
      sends.push(t.send_ms); if (t.changes?.length) firsts.push(t.changes[0]);
      const r = await latency.call({ op: "describe", lean: true });
      reads.push(r.serialize_ms?.reduce((a, b) => a + b, 0) ?? r.ms);
    }
    const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    timings[`tap_send_ms_${EXPECT[p].role}`] = sends; timings[`tap_first_change_ms_${EXPECT[p].role}`] = firsts; timings[`read_ms_${EXPECT[p].role}`] = reads;
    check(`taps on the ${EXPECT[p].role} screen change it fast (median send ${median(sends)?.toFixed(1)} ms, first change ${median(firsts)} ms, read ${median(reads)} ms)`, firsts.length >= 15 && median(firsts) < 120, JSON.stringify({ sends, firsts }));
  }
  await latency.stop();
} finally {
  writeFileSync(join(OUT, "duo-lab.json"), JSON.stringify({ udid, runtime: runtime?.identifier, rounds: ROUNDS, failed, results, timings }, null, 1));
  if (created && !KEEP) {
    await simctl("shutdown", udid).catch(() => undefined);
    await simctl("delete", udid).catch(() => undefined);
    console.log(`deleted the lab's Duo ${udid}`);
  }
  console.log(`${results.length - failed} of ${results.length} passed; ${OUT}/duo-lab.json`);
}
process.exit(failed ? 1 : 0);

/** One posture's checks: the look, taps on each half and by the fold, typing, scroll, swipe, hold, home, screenshots, a local recording. */
async function exercise(label, posture, round) {
  const want = EXPECT[posture];
  const split = posture === "book";
  // The app in front, on its grid.
  let look = await su("look", "--device", udid);
  if (!/DuoLab|Cell A1|Grid/.test(look.text)) { await su("app", "launch", "--app", APP, "--device", udid); look = await su("look", "--device", udid); }
  const first = look.text.split("\n")[0];
  const [role, points] = named(first);
  check(`${label}: ui_look's first line names ${posture} and the ${want.role} screen (${points})`, first.includes(`, ${posture}: `) && role === want.role && want.sizes.includes(points), first);
  note("look_ms", look.ms);
  const before = (await appLog(udid))?.touches?.length ?? 0;
  const taps = await su("act", "--device", udid, "tap Grid", 'tap "Cell A1"', 'tap "Cell C2"', 'tap "Near fold"');
  const log = await appLog(udid);
  const touched = (log?.touches ?? []).slice(before);
  const ids = touched.map((t) => t.id);
  check(`${label}: taps by label land where the app says, on both halves and beside the fold`, taps.ok && ["cell-A1", "cell-C2", "nearFold"].every((id) => ids.includes(id)) && touched.every((t) => t.inside) && (!split || touched.every((t) => t.mode.startsWith("split"))),
    JSON.stringify({ ids, modes: [...new Set(touched.map((t) => t.mode))], window: log?.window, text: taps.text.split("\n")[0] }));
  const text = `duo ${posture} ${round}`;
  const typed = await su("act", "--device", udid, "tap Tools", `fill #note "${text}"`);
  const afterTyping = await appLog(udid);
  check(`${label}: typing with the keyboard up reaches the app`, typed.ok && afterTyping?.text === text && /keyboard/.test(typed.text), JSON.stringify({ app: afterTyping?.text, said: typed.text.split("\n").slice(0, 2).join(" | ") }));
  const scrollBefore = afterTyping?.scrollY ?? 0, swipesBefore = afterTyping?.swipes?.length ?? 0, heldBefore = afterTyping?.held ?? 0;
  const gestures = await su("act", "--device", udid, "key return", "scroll down", 'swipe left "Swipe here"', 'hold "Hold me"');
  const afterGestures = await appLog(udid);
  check(`${label}: scroll, swipe and long press reach the app`, gestures.ok && afterGestures.scrollY > scrollBefore && afterGestures.swipes.length > swipesBefore && afterGestures.swipes.at(-1) === "left" && afterGestures.held > heldBefore,
    JSON.stringify({ scrollY: afterGestures?.scrollY, swipes: afterGestures?.swipes?.slice(-2), held: afterGestures?.held, said: gestures.text.split("\n")[0] }));
  // A picture of the screen in use: ours (the engine's, from the screen's own buffer) against simctl's of that display.
  const shot = await su("look", "--device", udid, "--screenshot-file");
  const file = /screenshot file: (\S+)/.exec(shot.text)?.[1];
  const theirs = join(OUT, `simctl-${posture}-r${round}.png`);
  await simctl("io", udid, "screenshot", `--display=${want.id}`, theirs).catch(() => undefined);
  const size = file && existsSync(file) ? pngSize(file) : "none";
  const diff = file && existsSync(theirs) ? await difference(file, theirs) : -1;
  const theirSize = existsSync(theirs) ? pngSize(theirs) : "none";
  check(`${label}: the screenshot is the ${want.role} screen at ${points ? pixelsOf(points) : "?"} and matches simctl's of display ${want.id} (${theirSize}, difference ${diff.toFixed?.(1)})`, points && size === pixelsOf(points) && theirSize === size && diff >= 0 && diff < 12, `ours ${size}`);
  // Home, then back to the app.
  const home = await su("act", "--device", udid, "home");
  const springboard = await su("look", "--device", udid);
  check(`${label}: home leaves the app`, home.ok && springboard.ok && /Home screen/.test(springboard.text.split("\n")[0]) && !/DuoLab|Cell A1/.test(springboard.text), `${springboard.text.split("\n")[0]} | home said: ${home.text.split("\n").slice(0, 3).join(" | ")}`);
  await su("app", "launch", "--app", APP, "--device", udid);
  // The live view's stills, of the screen in use.
  const stills = await exec("node", [join(root, "scripts/still-check.mjs"), udid]).then((r) => r.stdout, (e) => `${e.stdout ?? ""}${e.message}`);
  check(`${label}: stills of the ${want.role} screen`, /^stills ok: still \d+x\d+ of the (outer|inner) screen/.test(stills) && stills.includes(`of the ${want.role} screen`), stills.trim());
  // A local recording (simctl's, of the screen in use) once a round, closed and open.
  if (round === 1 && posture !== "book") {
    await su("record", "start", "--device", udid);
    await sleep(3_000);
    const stop = await su("record", "stop", "--device", udid);
    const mp4 = /: (\S+\.mp4)/.exec(stop.text)?.[1];
    const played = mp4 ? await plays(mp4).catch((e) => ({ error: String(e) })) : { error: stop.text };
    // simctl records the panel as its buffer is (unturned) and to even sides: the larger side within 2 pixels.
    const [w, h] = pixelsOf(points ?? "0x0").split("x").map(Number);
    check(`${label}: a local recording is of the ${want.role} screen and plays (${played.width}x${played.height})`, played.playable && Math.abs(Math.max(played.width, played.height) - Math.max(w, h)) <= 2 && played.frames?.some((f) => f.brightness > 5), JSON.stringify({ ...played, frames: played.frames?.length }).slice(0, 300));
  }
}
