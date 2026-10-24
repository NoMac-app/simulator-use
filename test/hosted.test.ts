import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { callSummary, copyExcept, forgetAppPaths, gitEnv, gitUrl, hosted, hostedText, noteCall, removeExcept, replayDir, setAnswerWithin, setFirstRead, setReplayRecorder } from "../src/hosted.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const project = "prj_" + "f".repeat(32);
let syncs = 0;
const syncId = () => "sync_" + (++syncs).toString(16).padStart(40, "0");

/** The client's side: the files as a manifest, and a gzip tar of the ones the host asked for. */
function client(files: Record<string, string>, mtime = 1_761_100_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "su-client-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const entries = Object.entries(files).map(([path, text]) => ({ path, size: Buffer.byteLength(text), mtime_ms: mtime, sha256: sha(text), kind: path.endsWith(".sh") ? "executable" : "file" }));
  const archive = (paths: string[]) => {
    const out = join(dir, "..", `${dir.split("/").pop()}.tar.gz`);
    const r = spawnSync("/usr/bin/tar", ["-czf", out, "-C", dir, ...paths]);
    assert.equal(r.status, 0, String(r.stderr));
    const bytes = readFileSync(out);
    return { base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  return { entries, archive };
}

async function sync(files: Record<string, string>, mtime?: number) {
  const id = syncId();
  const c = client(files, mtime);
  const { missing } = (await hosted("simulator-use/sync", { op: "manifest", id, project, page: 0, pages: 1, entries: c.entries })) as { missing: string[] };
  const placed = (await hosted("simulator-use/sync", { op: "place", id, ...(missing.length ? { archive: c.archive(missing) } : {}) })) as Record<string, unknown>;
  return { missing, placed };
}

test("the sync writes only what the workspace lacks, sets every mtime, and removes what the client deleted", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace, cache_dir: join(workspace, "cache") });
  const root = join(workspace, "src", project);
  const first = await sync({ "App/App.swift": "let a = 1\n", "App/Info.plist": "<plist/>", "run.sh": "echo hi\n" });
  assert.deepEqual(first.missing.sort(), ["App/App.swift", "App/Info.plist", "run.sh"]);
  assert.equal(first.placed.state, "done");
  assert.equal(first.placed.root, root);
  assert.equal(readFileSync(join(root, "App/App.swift"), "utf8"), "let a = 1\n");
  assert.equal(statSync(join(root, "App/App.swift")).mtimeMs, 1_761_100_000_000);
  assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, "App/Info.plist")).mode & 0o777, 0o644);

  // Something the host built beside the source stays (dependencies, build output).
  mkdirSync(join(root, "Pods"), { recursive: true });
  writeFileSync(join(root, "Pods/lib.a"), "built here");

  const second = await sync({ "App/App.swift": "let a = 2\n", "run.sh": "echo hi\n" }, 1_761_100_100_000);
  assert.deepEqual(second.missing, ["App/App.swift"], "one file changed, one deleted, one the same");
  assert.equal(second.placed.state, "done");
  assert.equal(second.placed.removed, 1);
  assert.equal(readFileSync(join(root, "App/App.swift"), "utf8"), "let a = 2\n");
  assert.equal(existsSync(join(root, "App/Info.plist")), false, "deleted on the client");
  assert.equal(statSync(join(root, "run.sh")).mtimeMs, 1_761_100_100_000, "an unchanged file still gets the client's mtime");
  assert.equal(readFileSync(join(root, "Pods/lib.a"), "utf8"), "built here");

  // A file the build removed from the folder is asked for again.
  spawnSync("rm", [join(root, "run.sh")]);
  const third = await sync({ "App/App.swift": "let a = 2\n", "run.sh": "echo hi\n" });
  assert.deepEqual(third.missing, ["run.sh"]);
  assert.ok(lstatSync(join(root, "run.sh")).isFile());
});

test("a place before every page arrived, an archive that is not the one announced, and paths outside are refused", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  const id = syncId();
  const c = client({ "a.txt": "a" });
  await hosted("simulator-use/sync", { op: "manifest", id, project, page: 0, pages: 2, entries: c.entries });
  await assert.rejects(hosted("simulator-use/sync", { op: "place", id }), /1 of 2 pages/);
  const other = syncId();
  await hosted("simulator-use/sync", { op: "manifest", id: other, project, page: 0, pages: 1, entries: c.entries });
  const archive = c.archive(["a.txt"]);
  const placed = (await hosted("simulator-use/sync", { op: "place", id: other, archive: { ...archive, sha256: "0".repeat(64) } })) as Record<string, unknown>;
  assert.equal(placed.state, "failed");
  assert.match(String(placed.error), /archive_checksum_mismatch/);
  for (const path of ["../x", "/etc/passwd", "a//b", "a\\b"]) {
    await assert.rejects(hosted("simulator-use/sync", { op: "manifest", id: syncId(), project, page: 0, pages: 1, entries: [{ ...c.entries[0], path }] }), /entry/);
  }
  await assert.rejects(hosted("simulator-use/sync", { op: "manifest", id: syncId(), project: "../x", page: 0, pages: 1, entries: [] }), /project/);
  await assert.rejects(hosted("simulator-use/sync", { op: "place", id: syncId() }), /unknown sync/);
});

test("a long place answers that it runs, and the same place again reads it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  setAnswerWithin(0);
  try {
    const id = syncId();
    const c = client({ "b.txt": "b" });
    await hosted("simulator-use/sync", { op: "manifest", id, project, page: 0, pages: 1, entries: c.entries });
    const archive = c.archive(["b.txt"]);
    const first = (await hosted("simulator-use/sync", { op: "place", id, archive })) as Record<string, unknown>;
    assert.equal(first.state, "running");
    setAnswerWithin(5_000);
    const again = (await hosted("simulator-use/sync", { op: "place", id, archive })) as Record<string, unknown>;
    assert.equal(again.state, "done");
  } finally {
    setAnswerWithin(8_000);
  }
});

test("a place whose archive lacks a requested file fails, and the next manifest asks for it again", async () => {
  // A client that splits a large first sync over several archives must not leave files the index claims.
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  const root = join(workspace, "src", project);
  const files = { "A.swift": "let a = 1\n", "B.swift": "let b = 1\n" };
  const c = client(files);
  const id = syncId();
  const { missing } = (await hosted("simulator-use/sync", { op: "manifest", id, project, page: 0, pages: 1, entries: c.entries })) as { missing: string[] };
  assert.deepEqual(missing.sort(), ["A.swift", "B.swift"]);
  const half = (await hosted("simulator-use/sync", { op: "place", id, archive: c.archive(["A.swift"]) })) as Record<string, unknown>;
  assert.equal(half.state, "failed");
  assert.match(String(half.error), /archive_incomplete: 1 of the 2 files asked for .*B\.swift \(not in the archive\)/);
  const again = (await hosted("simulator-use/sync", { op: "manifest", id: syncId(), project, page: 0, pages: 1, entries: c.entries })) as { missing: string[] };
  assert.deepEqual(again.missing.sort(), ["A.swift", "B.swift"], "the index took nothing from the failed place");
  const whole = await sync(files);
  assert.equal(whole.placed.state, "done");
  assert.equal(readFileSync(join(root, "B.swift"), "utf8"), "let b = 1\n");
});

test("an archive with other content than announced, or a file nobody asked for, is refused", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  const root = join(workspace, "src", project);
  // Content that is not what the manifest announced.
  const announced = client({ "C.swift": "let c = 1\n" });
  const sent = client({ "C.swift": "let c = 2\n" });
  const id = syncId();
  await hosted("simulator-use/sync", { op: "manifest", id, project, page: 0, pages: 1, entries: announced.entries });
  const differs = (await hosted("simulator-use/sync", { op: "place", id, archive: sent.archive(["C.swift"]) })) as Record<string, unknown>;
  assert.equal(differs.state, "failed");
  assert.match(String(differs.error), /archive_incomplete: .*C\.swift \(different content\)/);
  // A file the manifest did not ask for is never written.
  const asked = client({ "D.swift": "let d = 1\n" });
  const extra = client({ "D.swift": "let d = 1\n", "Extra.swift": "let x = 1\n" });
  const other = syncId();
  await hosted("simulator-use/sync", { op: "manifest", id: other, project, page: 0, pages: 1, entries: asked.entries });
  const unasked = (await hosted("simulator-use/sync", { op: "place", id: other, archive: extra.archive(["D.swift", "Extra.swift"]) })) as Record<string, unknown>;
  assert.equal(unasked.state, "failed");
  assert.match(String(unasked.error), /archive_unexpected: Extra\.swift was not asked for/);
  assert.equal(existsSync(join(root, "Extra.swift")), false);
});

test("answers read project paths relative to the project, and the host's other files as ids that get uploads", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  const cache = join(workspace, "cache");
  await hosted("simulator-use/configure", { workspace, cache_dir: cache });
  const root = join(workspace, "src", project);
  const log = join(cache, "DerivedData", "Demo-7f063f2e7788", "build-1.log");
  mkdirSync(join(log, ".."), { recursive: true });
  writeFileSync(log, "the build log");
  const text = [
    `Build of Demo failed after 1.1 s with 1 error. Full log: ${log}`,
    `${root}/Sources/App.swift:48:30: error: cannot find 'undefinedName' in scope`,
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/x.h:1:1: warning: from the SDK",
    `${root} does not exist.`,
    `A recording that is gone: ${join(cache, "gone.mp4")}.`,
  ].join("\n");
  const out = hostedText(text).split("\n");
  const id = /Full log: (file_[a-f0-9]{40})\/build-1\.log$/.exec(out[0]!)?.[1];
  assert.ok(id, out[0]);
  assert.equal(out[1], "Sources/App.swift:48:30: error: cannot find 'undefinedName' in scope");
  assert.match(out[2]!, /^\/Applications\/Xcode\.app/, "a path outside the host's own folders stays");
  assert.equal(out[3], ". does not exist.");
  assert.equal(out[4], `A recording that is gone: ${join(cache, "gone.mp4")}.`, "only files that exist become ids");
  assert.equal(hostedText(`Full log: ${log}`), `Full log: ${id}/build-1.log`, "the same file, the same id");

  // get uploads that file to the link NoMac signed.
  const sent: { url: string; method?: string; length: string | null; body: string }[] = [];
  const realFetch = globalThis.fetch;
  let storage = 200;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), method: init?.method, length: headers.get("content-length"), body: Buffer.from(await new Response(init?.body).arrayBuffer()).toString() });
    return new Response(null, { status: storage });
  }) as typeof fetch;
  try {
    const got = (await hosted("simulator-use/get", { id: `get_${"1".repeat(40)}`, file: id, url: "https://r2.example.test/put" })) as Record<string, unknown>;
    assert.deepEqual(got, { state: "done", size: 13 });
    assert.deepEqual(sent, [{ url: "https://r2.example.test/put", method: "PUT", length: "13", body: "the build log" }]);
    // The same id answers the upload it started, and uploads nothing again.
    assert.deepEqual(await hosted("simulator-use/get", { id: `get_${"1".repeat(40)}`, file: id, url: "https://r2.example.test/put" }), { state: "done", size: 13 });
    assert.equal(sent.length, 1);
    storage = 403;
    const refused = (await hosted("simulator-use/get", { id: `get_${"4".repeat(40)}`, file: id, url: "https://r2.example.test/put" })) as Record<string, unknown>;
    assert.equal(refused.state, "failed");
    assert.match(String(refused.error), /^upload_failed: storage answered 403/);
    await assert.rejects(hosted("simulator-use/get", { id: `get_${"2".repeat(40)}`, file: `file_${"0".repeat(40)}`, url: "https://r2.example.test/put" }), /file_not_found/);
    await assert.rejects(hosted("simulator-use/get", { id: `get_${"3".repeat(40)}`, file: id, url: "http://r2.example.test/put" }), /get id, file or url/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the pool's warm-up runs only before the hand-over, and a stop with none running answers so", async () => {
  // Configured (handed over): a warm-up now would build beside the customer's own work.
  await hosted("simulator-use/configure", { workspace: mkdtempSync(join(tmpdir(), "su-ws-")) });
  await assert.rejects(hosted("simulator-use/warm", {}), /the warm-up runs before the hand-over/);
  assert.deepEqual(await hosted("simulator-use/warm", { stop: true }), { ok: true, ms: 0, stopped: false });
});

test("a repository comes only by an https link without credentials, and its token only through git's environment", async () => {
  assert.equal(gitUrl("https://github.com/NoMac-app/simulator-use"), true);
  assert.equal(gitUrl("https://github.com/NoMac-app/simulator-use.git"), true);
  for (const bad of ["http://github.com/a/b", "git@github.com:a/b.git", "file:///etc", "https://user:token@github.com/a/b", "https://github.com/", "https://github.com/a/b?x=1", "https://github.com/a b", "ssh://github.com/a/b", "--upload-pack=x"]) {
    assert.equal(gitUrl(bad), false, bad);
  }
  const env = gitEnv("https://github.com/a/b", "ghp_secret");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`);
  assert.equal(gitEnv("https://gitlab.com/a/b", "t").GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("oauth2:t").toString("base64")}`);
  assert.equal(gitEnv("https://github.com/a/b", undefined).GIT_CONFIG_COUNT, undefined);
  const id = `clone_${"a".repeat(40)}`;
  await assert.rejects(hosted("simulator-use/clone", { id, url: "http://github.com/a/b" }), /https link/);
  await assert.rejects(hosted("simulator-use/clone", { id, url: "https://github.com/a/b", ref: "--upload-pack=touch" }), /ref/);
  await assert.rejects(hosted("simulator-use/clone", { id: "clone_x", url: "https://github.com/a/b" }), /clone id/);
});

test("an uploaded project or .app is unpacked into the workspace, only what differs moved in", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  const project = mkdtempSync(join(tmpdir(), "su-up-"));
  mkdirSync(join(project, "Sources"));
  writeFileSync(join(project, "Sources/A.swift"), "let a = 1\n");
  writeFileSync(join(project, "Sources/B.swift"), "let b = 1\n");
  const packed = (tgz: string, ...paths: string[]) => {
    spawnSync("tar", [...(process.platform === "darwin" ? ["--no-mac-metadata"] : []), "-czf", tgz, "-C", project, ...paths], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const data = readFileSync(tgz);
    return { data, sha256: createHash("sha256").update(data).digest("hex") };
  };
  const realFetch = globalThis.fetch;
  let body = Buffer.alloc(0);
  globalThis.fetch = (async () => new Response(new Uint8Array(body))) as typeof fetch;
  const fetchOnce = async (n: string, sha256: string, name = "demo") => {
    let answer: Record<string, unknown>;
    do answer = (await hosted("simulator-use/fetch", { id: `fetch_${n.repeat(40)}`, url: "https://r2.example.test/get", sha256, name })) as Record<string, unknown>;
    while (answer.state === "running");
    return answer;
  };
  try {
    const first = packed(join(project, "..", "first.tgz"), "Sources");
    body = first.data;
    const one = await fetchOnce("1", first.sha256);
    assert.equal(one.state, "done", String(one.error));
    assert.equal(one.written, 2);
    const root = String(one.root);
    assert.match(root, /\/src\/upload_[a-f0-9]{32}$/);
    mkdirSync(join(root, "DerivedData"));
    writeFileSync(join(root, "DerivedData/kept.o"), "x");
    const before = statSync(join(root, "Sources/A.swift")).mtimeMs;
    // Next upload: B changed, A the same, a new C; B's old self goes, A keeps its mtime, build output stays.
    writeFileSync(join(project, "Sources/B.swift"), "let b = 2\n");
    writeFileSync(join(project, "Sources/C.swift"), "let c = 3\n");
    const second = packed(join(project, "..", "second.tgz"), "Sources/A.swift", "Sources/B.swift", "Sources/C.swift");
    body = second.data;
    const two = await fetchOnce("2", second.sha256);
    assert.equal(two.state, "done", String(two.error));
    assert.equal(two.written, 2);
    assert.equal(two.removed, 0);
    assert.equal(statSync(join(root, "Sources/A.swift")).mtimeMs, before);
    assert.equal(readFileSync(join(root, "Sources/B.swift"), "utf8"), "let b = 2\n");
    assert.equal(existsSync(join(root, "DerivedData/kept.o")), true);
    const third = packed(join(project, "..", "third.tgz"), "Sources/A.swift");
    body = third.data;
    const three = await fetchOnce("3", third.sha256);
    assert.equal(three.removed, 2);
    assert.equal(existsSync(join(root, "Sources/C.swift")), false);
    const wrong = await fetchOnce("5", "0".repeat(64), "other");
    assert.equal(wrong.state, "failed");
    assert.match(String(wrong.error), /^upload_checksum_mismatch/);
    await assert.rejects(hosted("simulator-use/fetch", { id: `fetch_${"6".repeat(40)}`, url: "https://r2.example.test/get", sha256: first.sha256, name: "../x" }), /name/);
    // A zip with a .app inside its one folder: the app's path comes back for app_control install (ditto, on a Mac).
    if (process.platform !== "darwin") return;
    const appDir = mkdtempSync(join(tmpdir(), "su-app-"));
    mkdirSync(join(appDir, "Build/Demo.app"), { recursive: true });
    writeFileSync(join(appDir, "Build/Demo.app/Info.plist"), "<plist/>");
    const zip = join(appDir, "demo.zip");
    spawnSync("/usr/bin/ditto", ["-c", "-k", join(appDir, "Build"), zip]);
    body = readFileSync(zip);
    const app = await fetchOnce("4", createHash("sha256").update(body).digest("hex"), "demo-app");
    assert.equal(app.state, "done", String(app.error));
    assert.match(String(app.app), /\/src\/upload_[a-f0-9]{32}\/Demo\.app$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the replay lists every call without what was typed, and its stop leaves the video and the list for NoMac", async () => {
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-state-"));
  assert.deepEqual(await hosted("simulator-use/replay", { op: "stop" }), { recording: false }, "a stop with none recording");
  // A recorder that writes the video once it is asked to end, as simctl does.
  setReplayRecorder(async (file) => spawn("/bin/sh", ["-c", `trap 'printf video > "${file}"; exit 0' INT; while :; do sleep 0.1; done`], { stdio: "ignore" }));
  assert.deepEqual(await hosted("simulator-use/replay", { op: "start" }), { recording: true });
  assert.deepEqual(await hosted("simulator-use/replay", { op: "start" }), { recording: true }, "a second start keeps the first recording");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const at = Date.now();
  noteCall("ui_act", { steps: ['fill #password "hunter2"', "tap Sign in", "type secret words"] }, at, { content: [{ type: "text", text: 'fill #password "hunter2" failed: no field' }], isError: true });
  noteCall("app_control", { action: "open_url", app: "https://example.com/?token=abc" }, at, { content: [{ type: "text", text: "Opened." }] });
  noteCall("ui_look", {}, at, { content: [{ type: "text", text: "Home screen" }] });
  const done = (await hosted("simulator-use/replay", { op: "stop" })) as Record<string, unknown>;
  assert.equal(done.recording, false);
  assert.equal(done.calls, 3);
  assert.equal(done.video, true);
  assert.equal(readFileSync(join(replayDir(), "video.mp4"), "utf8"), "video");
  const log = JSON.parse(readFileSync(join(replayDir(), "log.json"), "utf8")) as { calls: Array<Record<string, unknown>>; video: boolean };
  assert.equal(log.video, true);
  assert.deepEqual(log.calls.map((c) => c.what), ["fill #password … · tap Sign in · type …", "open_url (a link)", "ui_look"]);
  assert.equal(log.calls[0]!.said, "fill #password … failed: no field");
  assert.equal(log.calls[0]!.ok, false);
  assert.ok((log.calls[0]!.at_ms as number) >= 300);
  assert.doesNotMatch(readFileSync(join(replayDir(), "log.json"), "utf8"), /hunter2|secret words|token=abc/);
  // A call after the stop is not listed anywhere.
  noteCall("ui_look", {}, Date.now(), { content: [] });
  assert.equal(callSummary("app_run", { git: "https://x" }), "app_run");
});

test("the pool's first read asks the engine again until it reads, and says when it never did", async () => {
  const answers = [undefined, { ok: false, error: "nilError" }, { ok: true, tree: [] }];
  const asked: number[] = [];
  setFirstRead(async (timeoutMs) => { asked.push(timeoutMs); return answers.shift(); });
  const read = (await hosted("simulator-use/readable", { within_ms: 30_000 })) as Record<string, unknown>;
  assert.equal(read.readable, true);
  assert.equal(read.tries, 3);
  assert.ok(asked.every((t) => t > 0 && t <= 30_000));
  setFirstRead(async () => ({ ok: false, error: "nilError" }));
  const never = (await hosted("simulator-use/readable", { within_ms: 1_000 })) as Record<string, unknown>;
  assert.equal(never.readable, false);
  assert.equal(never.error, "nilError");
  setFirstRead(undefined);
});

// States are copied with ditto, a Mac's, as the phone's host does.
test("a saved state leaves out caches and the system's assets, and a restore keeps the phone's own assets", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "su-state-"));
  const phone = join(root, "phone");
  for (const [path, text] of [["Library/Preferences/app.plist", "prefs"], ["Library/Caches/big", "cache"], ["Containers/Data/Application/A/doc", "doc"],
    ["private/var/MobileAsset/AssetsV2/voice", "voice"], ["private/var/db/keep", "db"], ["tmp/scratch", "tmp"]] as Array<[string, string]>) {
    mkdirSync(join(phone, dirname(path)), { recursive: true });
    writeFileSync(join(phone, path), text);
  }
  await copyExcept(phone, join(root, "state"), ["Library/Caches", "Library/Logs", "tmp", "private/var/MobileAsset"]);
  const saved = (path: string) => existsSync(join(root, "state", path));
  assert.ok(saved("Library/Preferences/app.plist") && saved("Containers/Data/Application/A/doc") && saved("private/var/db/keep"));
  assert.ok(!saved("Library/Caches") && !saved("tmp") && !saved("private/var/MobileAsset"));
  // The next phone: its own data and assets; a restore leaves only the assets before the state goes in.
  writeFileSync(join(phone, "Containers/Data/Application/A/doc"), "the next phone's own");
  await removeExcept(phone, "private/var/MobileAsset");
  assert.ok(existsSync(join(phone, "private/var/MobileAsset/AssetsV2/voice")));
  assert.ok(!existsSync(join(phone, "Library")) && !existsSync(join(phone, "Containers")) && !existsSync(join(phone, "private/var/db")) && !existsSync(join(phone, "tmp")));
});

test("a restore forgets LaunchServices' databases (apps by another phone's paths), keeping its journal and app protection", async () => {
  const data = mkdtempSync(join(tmpdir(), "su-lsd-"));
  const lsd = join(data, "var/db/lsd");
  mkdirSync(join(lsd, "com.apple.LaunchServices.InstallJournal"), { recursive: true });
  for (const name of ["com.apple.LaunchServices-33554481-v2.csstore", "SystemDataOnly-com.apple.LaunchServices-33554481-v2.csstore", "com.apple.LaunchServicesAppProtectionStore.plist"]) writeFileSync(join(lsd, name), "x");
  await forgetAppPaths(data);
  assert.deepEqual(readdirSync(lsd).sort(), ["com.apple.LaunchServices.InstallJournal", "com.apple.LaunchServicesAppProtectionStore.plist"]);
  await forgetAppPaths(join(data, "none"));
});

test("saved phone states: checked names and ids, listed with their size, deleted, kept in the workspace only", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "su-ws-"));
  await hosted("simulator-use/configure", { workspace });
  const id = (n: number) => `state_${String(n).repeat(40)}`;
  assert.deepEqual(await hosted("simulator-use/state", { id: id(1), action: "list" }), { state: "done", states: [] });
  // A state as save leaves it: its data and what it was saved from.
  mkdirSync(join(workspace, "phone-states", "signed-in", "data"), { recursive: true });
  writeFileSync(join(workspace, "phone-states", "signed-in", "state.json"), JSON.stringify({ name: "signed-in", bytes: 632184832, saved_at: "2026-10-24T07:11:18.500Z", device: "iPhone 17 Pro", runtime: "iOS 27.0" }));
  mkdirSync(join(workspace, "phone-states", "half.saving"), { recursive: true });
  const listed = (await hosted("simulator-use/state", { id: id(2), action: "list" })) as { states: Array<{ name: string }> };
  assert.deepEqual(listed.states.map((s) => s.name), ["signed-in"], "a state still being written is not listed");
  for (const bad of [{ id: "state_1", action: "list" }, { id: id(3), action: "save", name: "../escape" }, { id: id(3), action: "save", name: "" }, { id: id(3), action: "wipe", name: "x" }]) {
    await assert.rejects(hosted("simulator-use/state", bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(await hosted("simulator-use/state", { id: id(4), action: "delete", name: "signed-in" }), { state: "done", states: [] });
  assert.equal(existsSync(join(workspace, "phone-states", "signed-in")), false);
});
