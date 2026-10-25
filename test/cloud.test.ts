import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { existsSync } from "node:fs";

import { parseArgs } from "../src/cli.ts";
import { withSource } from "../src/cloud/account.ts";
import { listProject, normalizeRemote, pages, projectId } from "../src/cloud/sync.ts";
import { callTool, TOOLS } from "../src/registry.ts";

test("a project is listed without build output, dependencies or editor state, symlinks as symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-proj-"));
  mkdirSync(join(dir, "Sources"));
  mkdirSync(join(dir, "DerivedData/x"), { recursive: true });
  mkdirSync(join(dir, "node_modules/a"), { recursive: true });
  mkdirSync(join(dir, "App.xcodeproj/xcuserdata"), { recursive: true });
  writeFileSync(join(dir, "Sources/App.swift"), "import SwiftUI\n");
  writeFileSync(join(dir, "DerivedData/x/out.o"), "x");
  writeFileSync(join(dir, "node_modules/a/i.js"), "x");
  writeFileSync(join(dir, "App.xcodeproj/project.pbxproj"), "// pbx\n");
  writeFileSync(join(dir, "App.xcodeproj/xcuserdata/me.xcuserstate"), "x");
  writeFileSync(join(dir, ".DS_Store"), "x");
  symlinkSync("Sources/App.swift", join(dir, "link.swift"));
  const listed = await listProject(dir);
  assert.deepEqual(listed.map((e) => `${e.path}:${e.kind}`), ["App.xcodeproj/project.pbxproj:file", "Sources/App.swift:file", "link.swift:symlink"]);
  assert.equal(listed[2]!.size, "Sources/App.swift".length);
});

test("a file changed in place, its size and mtime kept, is read again: its ctime moved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-index-"));
  const file = join(dir, "A.swift");
  const past = new Date("2020-01-01T00:00:00Z");
  writeFileSync(file, "let a = 1\n");
  utimesSync(file, past, past);
  const first = (await listProject(dir))[0]!;
  writeFileSync(file, "let a = 2\n");
  utimesSync(file, past, past);
  const second = (await listProject(dir))[0]!;
  assert.equal(second.mtime_ms, past.getTime());
  assert.equal(second.size, first.size);
  assert.equal(second.sha256, createHash("sha256").update("let a = 2\n").digest("hex"));
});

test("an unchanged file's hash comes from the index; SIMULATOR_USE_SYNC_INDEX=0 reads every file", async () => {
  const state = process.env.SIMULATOR_USE_STATE_DIR;
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-index-state-"));
  try {
    const dir = mkdtempSync(join(tmpdir(), "su-index-"));
    const past = new Date("2020-01-01T00:00:00Z");
    writeFileSync(join(dir, "A.swift"), "let a = 1\n");
    utimesSync(join(dir, "A.swift"), past, past);
    const real = (await listProject(dir))[0]!.sha256;
    const folder = join(process.env.SIMULATOR_USE_STATE_DIR, "sync-index");
    const [name] = readdirSync(folder);
    const index = JSON.parse(readFileSync(join(folder, name!), "utf8"));
    index.files["A.swift"].sha256 = "f".repeat(64);
    writeFileSync(join(folder, name!), JSON.stringify(index));
    assert.equal((await listProject(dir))[0]!.sha256, "f".repeat(64), "the index was read, not the file");
    process.env.SIMULATOR_USE_SYNC_INDEX = "0";
    assert.equal((await listProject(dir))[0]!.sha256, real);
  } finally {
    delete process.env.SIMULATOR_USE_SYNC_INDEX;
    process.env.SIMULATOR_USE_STATE_DIR = state;
  }
});

test("a warm listing of 20,000 files reads none of them: well under the time hashing them all takes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-index-big-"));
  const body = Buffer.alloc(4096, "x");
  for (let d = 0; d < 200; d++) {
    mkdirSync(join(dir, `Sources${d}`));
    for (let f = 0; f < 100; f++) writeFileSync(join(dir, `Sources${d}`, `F${f}.swift`), body);
  }
  try {
    // Past the racy window of the files just written, so the index can vouch for them.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await listProject(dir);
    let started = performance.now();
    const warm = await listProject(dir);
    const warmMs = performance.now() - started;
    process.env.SIMULATOR_USE_SYNC_INDEX = "0";
    started = performance.now();
    const cold = await listProject(dir);
    const coldMs = performance.now() - started;
    assert.equal(warm.length, 20_000);
    assert.deepEqual(warm.map((e) => e.sha256), cold.map((e) => e.sha256));
    assert.ok(warmMs < 300 && warmMs * 3 < coldMs, `warm ${warmMs.toFixed(0)} ms, every file read ${coldMs.toFixed(0)} ms`);
  } finally {
    delete process.env.SIMULATOR_USE_SYNC_INDEX;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest pages hold at most 1000 entries and about 192 KiB, in order", () => {
  const entry = (i: number, long = false) => ({ path: `${long ? "x".repeat(900) : "f"}/${i}.swift`, size: 1, mtime_ms: 1, sha256: "e".repeat(64), kind: "file" as const });
  assert.deepEqual(pages(Array.from({ length: 2500 }, (_, i) => entry(i))).map((p) => p.length), [1000, 1000, 500]);
  const long = pages(Array.from({ length: 300 }, (_, i) => entry(i, true)));
  assert.ok(long.length >= 2 && long.every((p) => JSON.stringify(p).length < 200 * 1024));
  assert.equal(long.flat().length, 300);
  assert.deepEqual(pages([]), [[]]);
});

test("on Windows, a script git tracks as executable is sent as one: Windows keeps no executable bit", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "su-win-"));
  writeFileSync(join(dir, "build.sh"), "#!/bin/sh\necho ok\n", { mode: 0o644 });
  writeFileSync(join(dir, "App.swift"), "import SwiftUI\n", { mode: 0o644 });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "App.swift"]);
  execFileSync("git", ["-C", dir, "update-index", "--add", "--chmod=+x", "build.sh"]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const kinds = Object.fromEntries((await listProject(dir)).map((e) => [e.path, e.kind]));
    assert.deepEqual(kinds, { "App.swift": "file", "build.sh": "executable" });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("manifest pages go 4 at a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-pages-"));
  for (let i = 0; i < 4500; i++) writeFileSync(join(dir, `F${String(i).padStart(4, "0")}.swift`), `// ${i}\n`);
  let inFlight = 0, most = 0;
  const pagesSeen: number[] = [];
  const api = {
    json: async (_method: string, _path: string, body: { op: string; page?: number; pages?: number }) => {
      if (body.op === "place") return { state: "done", root: "/Volumes/nmw-x/src/prj_x" };
      inFlight++;
      most = Math.max(most, inFlight);
      pagesSeen.push(body.page!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      return { missing: [] };
    },
  };
  const { syncFolder } = await import("../src/cloud/sync.ts");
  const synced = await syncFolder(api as never, "ses_x", dir);
  assert.equal(synced.files, 4500);
  assert.deepEqual([...pagesSeen].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(most, 4);
  rmSync(dir, { recursive: true, force: true });
});

test("a repository is one project whichever way it is cloned", async () => {
  assert.equal(normalizeRemote("git@github.com:NoMac-app/simulator-use.git"), "github.com/NoMac-app/simulator-use");
  assert.equal(normalizeRemote("https://user:token@GitHub.com/NoMac-app/simulator-use/"), "github.com/NoMac-app/simulator-use");
  assert.equal(normalizeRemote("https://github.com/NoMac-app/simulator-use.git"), "github.com/NoMac-app/simulator-use");
  const dir = mkdtempSync(join(tmpdir(), "su-noremote-"));
  assert.match(await projectId(dir), /^prj_[a-f0-9]{32}$/);
  assert.equal(await projectId(dir), await projectId(dir));
});

// ---- Cloud mode against a stand-in for NoMac's API ------------------------------------------------------

let server: Server;
const seen: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
let phoneState = "ready";
// A build log's link, as NoMac makes them: its payload names the file. It works while the phone runs.
const LOG_TOKEN = `${Buffer.from(JSON.stringify({ n: "build.log" })).toString("base64url")}.sig`;
const local = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const read = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on("data", (d: Buffer) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts))); });

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = req.url ?? "";
    const body = req.headers["content-type"] === "application/json" && raw.length ? JSON.parse(raw.toString()) : raw.length;
    seen.push({ method: req.method ?? "", path, body, key: req.headers["idempotency-key"] as string | undefined });
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    // A file link needs no key: the link is the permission.
    if (path === "/api/v1/simulator/files/rec.tok") { res.writeHead(200, { "content-type": "video/mp4" }); res.end("mp4"); return; }
    if (path === `/api/v1/simulator/files/${LOG_TOKEN}`) {
      if (phoneState === "stopped") return send(410, { error: { code: "file_gone", message: "That file is gone: the phone ended." } });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Demo.swift:3: error: cannot find 'x' in scope\n");
      return;
    }
    if (req.headers.authorization !== "Bearer nmk_test") return send(401, { error: { code: "unauthorized", message: "no" } });
    if (req.method === "POST" && path === "/api/v1/simulator/sessions") return send(202, { session: { id: "ses_phone", state: "queued" }, links: { view: "https://nomac.app/simulator-use/view/w.x", control: "https://nomac.app/simulator-use/view/c.x", expires_at: "2026-10-24T12:00:00.000Z", replay: "https://nomac.app/simulator-use/replay/r.x" } });
    if (req.method === "GET" && path === "/api/v1/simulator/sessions/ses_phone") {
      if (phoneState === "gone") return send(409, { error: { code: "session_not_ready", message: "not running" } });
      const queued = phoneState === "queued" ? { message: "Every phone is in use: NoMac Simulator runs 2 at once, and it is next." } : {};
      return send(200, { session: { id: "ses_phone", state: phoneState, ...queued, cost: { accrued_microunits: "26667", billable_seconds: 120 }, cleanup_confirmed: phoneState === "stopped" } });
    }
    if (req.method === "DELETE" && path === "/api/v1/simulator/sessions/ses_phone") { phoneState = "stopped"; return send(202, { session: { id: "ses_phone", state: "stopping" }, links: { replay: "https://nomac.app/simulator-use/replay/r.x" } }); }
    if (path === "/api/v1/simulator/sessions/ses_phone/sync") {
      const op = body as { op: string; entries?: { path: string }[] };
      if (op.op === "manifest") return send(200, { missing: (op.entries ?? []).map((e) => e.path).filter((p) => p.endsWith(".swift")) });
      return send(200, { state: "done", root: "/Volumes/nmw-x/src/prj_x", written: 1 });
    }
    if (req.method === "PUT" && path.startsWith("/api/v1/simulator/sessions/ses_phone/sync/blobs/")) return send(200, { complete: true });
    if (path === "/api/v1/simulator/sessions/ses_phone/tools/app_run") {
      if (phoneState === "gone") return send(409, { error: { code: "session_not_ready", message: "not running" } });
      return send(200, { id: "call_1", state: "running" });
    }
    if (path === "/api/v1/simulator/sessions/ses_phone/tools/tests_run") return send(200, { id: "call_2", state: "done", result: { content: [{ type: "text", text: "3 tests passed in 9.6 s." }] } });
    if (path === "/api/v1/simulator/sessions/ses_phone/tools/screen_record") return send(200, { id: "call_4", state: "done", result: { content: [{ type: "text", text: (body as { action: string }).action === "start" ? "Recording iPhone 17 Pro." : `Recorded 12 s (1 MB): http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/simulator/files/rec.tok` }] } });
    if (path === "/api/v1/simulator/sessions/ses_phone/tools/ui_look") return send(200, { id: "call_3", state: "done", result: { content: [{ type: "text", text: "Demo · Sign In" }, { type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" }] } });
    if (path === "/api/v1/simulator/sessions/ses_phone/calls/call_1") return send(200, { id: "call_1", state: "done", result: { content: [{ type: "text", text: `Built Demo in 1.2 s, installed dev.simtap.demo.\nFull log: ${local()}/api/v1/simulator/files/${LOG_TOKEN}` }] } });
    send(404, { error: { code: "not_found", message: path } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  process.env.NOMAC_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.NOMAC_API_KEY = "nmk_test";
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-cloud-state-"));
});
after(() => { server.close(); delete process.env.NOMAC_API_URL; delete process.env.NOMAC_API_KEY; delete process.env.SIMULATOR_USE_STATE_DIR; });

test("cloud start, then every tool on the phone: app_run sends the project first and takes the phone's path; stop goes back", async () => {
  const project = mkdtempSync(join(tmpdir(), "su-app-"));
  mkdirSync(join(project, "Sources"));
  writeFileSync(join(project, "Sources/App.swift"), "import SwiftUI\n");
  writeFileSync(join(project, "project.yml"), "name: Demo\n");

  const started = await callTool("cloud", { action: "start" });
  assert.match(started.text, /^Cloud phone ready in [\d.]+ s/);
  assert.match(started.text, /A person can watch it at https:\/\/nomac\.app\/simulator-use\/view\/w\.x or use it at https:\/\/nomac\.app\/simulator-use\/view\/c\.x\./);
  assert.match(seen.find((r) => r.method === "POST" && r.path === "/api/v1/simulator/sessions")!.key ?? "", /^cli-start-/);

  const ran = await callTool("app_run", { path: project });
  assert.equal(ran.isError, undefined, ran.text);
  assert.match(ran.text, /^Sent 1 of 2 files \(1 KB\) in [\d.]+ s\.\nBuilt Demo in 1\.2 s/);
  assert.ok(ran.text.includes(`Full log: ${local()}/api/v1/simulator/files/${LOG_TOKEN}`), "links stay links");
  const call = seen.find((r) => r.path.endsWith("/tools/app_run"))!;
  assert.deepEqual(call.body, { path: "/Volumes/nmw-x/src/prj_x" });
  assert.match(call.key ?? "", /^cli-app_run-[a-f0-9]{32}$/);
  const manifest = seen.find((r) => (r.body as { op?: string }).op === "manifest")!.body as { project: string; pages: number; entries: { path: string }[] };
  assert.equal(manifest.pages, 1);
  assert.deepEqual(manifest.entries.map((e) => e.path).sort(), ["Sources/App.swift", "project.yml"]);

  assert.match((await callTool("cloud", { action: "status" })).text, /phone ses_phone is ready; 2 min so far, \$0\.03/);

  // The phone ends elsewhere: the next tool says so, and cloud mode forgets it.
  phoneState = "gone";
  const gone = await callTool("app_run", { path: project });
  assert.equal(gone.isError, true);
  assert.match(gone.text, /The cloud phone ses_phone has ended/);
  phoneState = "ready";
  assert.match((await callTool("cloud", { action: "status" })).text, /^Cloud is on but has no phone yet/);
  assert.match((await callTool("cloud", { action: "start" })).text, /^Cloud phone ready/);

  // A phone waiting for a free one says where it is in line.
  phoneState = "queued";
  assert.match((await callTool("cloud", { action: "status" })).text, /^Cloud is on: phone ses_phone is waiting\. Every phone is in use: NoMac Simulator runs 2 at once, and it is next\.$/);
  phoneState = "ready";
  const stopped = await callTool("cloud", { action: "stop" });
  assert.match(stopped.text, /The tools run on this machine again/);
  assert.match(stopped.text, /Its replay, the screen and every call, opens at https:\/\/nomac\.app\/simulator-use\/replay\/r\.x in a minute \(kept 7 days\)\./);
  assert.match((await callTool("cloud", { action: "status" })).text, /^Cloud is off/);
});

test("cloud run is CI in one line: start, build and run, the tests, a screenshot kept, stop", async () => {
  const cloud = TOOLS.find((t) => t.name === "cloud")!;
  assert.deepEqual(parseArgs(cloud, ["run", ".", "--tests"]), { action: "run", path: ".", tests: true });
  const project = mkdtempSync(join(tmpdir(), "su-ci-"));
  mkdirSync(join(project, "Sources"));
  writeFileSync(join(project, "Sources/App.swift"), "import SwiftUI\n");
  const out = mkdtempSync(join(tmpdir(), "su-ci-out-"));
  phoneState = "ready";
  const ran = await callTool("cloud", { action: "run", path: project, tests: true, out }, { waitForJobs: true });
  assert.equal(ran.isError, undefined, ran.text);
  assert.match(ran.text, /Built Demo in 1\.2 s/);
  assert.match(ran.text, /3 tests passed in 9\.6 s\./);
  const shot = /Screenshot: (\S+)/.exec(ran.text)?.[1];
  assert.ok(shot && shot.startsWith(out) && existsSync(shot), ran.text);
  const video = /Recording: (\S+)/.exec(ran.text)?.[1];
  assert.ok(video && video.startsWith(out) && video.endsWith(".mp4") && existsSync(video), ran.text);
  assert.match(ran.text, /Stopped the cloud phone/);
  assert.match(ran.text, /Its replay, the screen and every call, opens at https:\/\/nomac\.app\/simulator-use\/replay\/r\.x/);
  // The build log's link ends with the phone: the run kept the file, and names it instead.
  assert.ok(ran.text.includes(`Full log: ${join(out, "build.log")}`), ran.text);
  assert.ok(!ran.text.includes(LOG_TOKEN), "no dead link left");
  assert.equal(readFileSync(join(out, "build.log"), "utf8"), "Demo.swift:3: error: cannot find 'x' in scope\n");
  assert.equal((await fetch(`${local()}/api/v1/simulator/files/${LOG_TOKEN}`)).status, 410);
  assert.match((await callTool("cloud", { action: "status" })).text, /^Cloud is off/);
});

test("the sign-in link names simulator-use as its source", () => {
  assert.equal(withSource("https://nomac.app/device?code=WXYZ-2345"), "https://nomac.app/device?code=WXYZ-2345&utm_source=simulator-use");
  assert.equal(withSource("not a link"), "not a link");
});

