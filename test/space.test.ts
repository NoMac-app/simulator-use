import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { build, findProject, knownFix } from "../src/engine/xcode.ts";
import { hosted, setAnswerWithin, setFirstRead } from "../src/hosted.ts";
import { clearForNoSpace, ensureRoom, floorOf, fullText, hold, noSpace, type Report, retryWithRoom, setMeasure, setNotifier, settled, STORED } from "../src/space.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Bytes of the files under dir, links not followed; a state's metadata (.json) weighs nothing here. */
function used(dir: string): number {
  let bytes = 0;
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && !name.endsWith(".json")) bytes += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return bytes;
}

/**
 * The workspace as an APFS volume with a quota, small enough for a test: each byte written in it stands for a MiB,
 * so a 10 GB workspace's floor (2 GiB) is 2048 bytes of files.
 */
function volume(quota = 10e9) {
  setMeasure(async (dir) => ({ total: quota, free: Math.max(0, quota - used(dir) * MIB) }));
}

function file(path: string, mib: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(mib, 120));
}

/** A state copy as a save leaves it, marked as in NoMac's storage when stored names that save (and its last use). */
function stateCopy(ws: string, name: string, mib: number, savedAt: string, stored?: { savedAt?: string; usedAt: string }) {
  const dir = join(ws, "phone-states", name);
  file(join(dir, "data", "Library", "app.db"), mib);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ name, bytes: mib * MIB, saved_at: savedAt, device: "iPhone 17 Pro", runtime: "iOS 27.0" }));
  if (stored) writeFileSync(join(dir, STORED), JSON.stringify({ saved_at: stored.savedAt ?? savedAt, used_at: stored.usedAt }));
  return dir;
}

/** A build cache last used at when. */
function derivedData(ws: string, name: string, mib: number, when: number) {
  const dir = join(ws, "cache", "DerivedData", name);
  file(join(dir, "Build", "Products", "App.app", "App"), mib);
  utimesSync(dir, when / 1000, when / 1000);
  return dir;
}

async function mounted(ws: string) {
  await hosted("simulator-use/configure", { workspace: ws, cache_dir: join(ws, "cache") });
  await settled();
}

const reports: Report[] = [];
setNotifier((r) => reports.push(r));

test("the floor is the larger of 2 GiB and a fifth of the quota", () => {
  assert.equal(floorOf(10e9), 2 * GIB, "a 10 GB workspace keeps 2 GiB free");
  assert.equal(floorOf(20e9), 4e9, "a 20 GB one keeps a fifth, 3.7 GiB");
  assert.equal(floorOf(5e9), 2 * GIB);
});

test("below the floor, copies of states kept in NoMac's storage go before build caches, least recently used first, until the floor is back", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  file(join(ws, "src", "prj_" + "a".repeat(32), "Sources", "App.swift"), 3000);
  const old = stateCopy(ws, "old", 1500, "2026-10-01T10:00:00.000Z", { usedAt: "2026-10-01T10:00:00.000Z" });
  // Saved long ago but restored lately: used more recently than old.
  const lately = stateCopy(ws, "lately", 1500, "2026-09-01T10:00:00.000Z", { usedAt: "2026-10-30T10:00:00.000Z" });
  const now = Date.now();
  const older = derivedData(ws, "Old-aaaaaaaaaaaa", 1000, now - 86_400_000);
  const newest = derivedData(ws, "Newest-bbbbbbbbbbbb", 1000, now);
  // 8000 of about 9537 MiB in use: 1.6 GB free, under the 2 GiB floor. One copy brings it back.
  reports.length = 0;
  await mounted(ws);
  assert.equal(existsSync(old), false, "the least recently used copy went");
  assert.ok(existsSync(lately) && existsSync(older) && existsSync(newest), "and only it: the floor was back");
  assert.equal(reports.length, 1);
  const [mount] = reports;
  assert.equal(mount!.reason, "mount");
  assert.equal(mount!.states, 1);
  assert.equal(mount!.state_bytes, 1500 * MIB);
  assert.equal(mount!.caches, 0);
  assert.ok(mount!.free_after >= floorOf(10e9) && mount!.free_before < floorOf(10e9));
  // Sizes and counts only: no name or path of the workspace.
  assert.ok(Object.values(mount!).every((v) => typeof v === "number" || v === "mount"), JSON.stringify(mount));
  // A write that wants more: the other copy, then the older cache; the newest cache stays whatever is wanted.
  await ensureRoom("upload", 5e9);
  assert.equal(existsSync(lately), false);
  assert.equal(existsSync(older), false);
  assert.equal(existsSync(newest), true);
  assert.ok(existsSync(join(ws, "src", "prj_" + "a".repeat(32), "Sources", "App.swift")));
  // With room, nothing goes.
  reports.length = 0;
  await ensureRoom("upload");
  assert.equal(reports.length, 0);
});

test("never the account's files, a copy not known to be in NoMac's storage, the state saved or restored now, or a cache in use, nor through a link", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  // The account's projects, clones and uploads (with build output of their own inside), a sync's index, a file of its own.
  const own = [join(ws, "src", "prj_" + "b".repeat(32), "DerivedData", "x.o"), join(ws, "src", "git_" + "c".repeat(32), "Pods", "Foo.swift"),
    join(ws, "src", "upload_" + "d".repeat(32), "Demo.app", "Demo"), join(ws, "src", ".nomac-sync", "prj_" + "b".repeat(32) + ".json"), join(ws, "notes.txt")];
  for (const path of own) file(path, 10);
  const saved = "2026-10-20T10:00:00.000Z";
  const localOnly = stateCopy(ws, "local-only", 100, saved);
  const resaved = stateCopy(ws, "resaved", 100, "2026-10-29T10:00:00.000Z", { savedAt: saved, usedAt: saved });
  const saving = stateCopy(ws, "being-saved", 100, saved, { usedAt: saved });
  const namedLikeLeftover = stateCopy(ws, "x.saving", 100, saved);
  const stored = stateCopy(ws, "stored", 100, saved, { usedAt: saved });
  const now = Date.now();
  const building = derivedData(ws, "Building-cccccccccccc", 100, now - 3 * 86_400_000);
  const newest = derivedData(ws, "Newest-dddddddddddd", 100, now);
  const idle = derivedData(ws, "Idle-eeeeeeeeeeee", 100, now - 2 * 86_400_000);
  const releaseState = hold("state", "being-saved");
  const releaseCache = hold("cache", building);
  try {
    reports.length = 0;
    await clearForNoSpace("no_space");
  } finally {
    releaseState();
    releaseCache();
  }
  assert.equal(existsSync(stored), false);
  assert.equal(existsSync(idle), false);
  for (const dir of [localOnly, resaved, saving, namedLikeLeftover]) assert.ok(existsSync(join(dir, "data", "Library", "app.db")), `${dir} was kept`);
  for (const dir of [building, newest]) assert.ok(existsSync(join(dir, "Build", "Products", "App.app", "App")), `${dir} was kept`);
  for (const path of own) assert.ok(existsSync(path), `${path} was kept`);
  assert.deepEqual(readdirSync(join(ws, ".nomac-trash")), [], "nothing is left half deleted");
  assert.equal(reports[0]?.states, 1);
  assert.equal(reports[0]?.caches, 1);

  // Code in the workspace that puts a link where the cache or the states go: nothing behind it is touched.
  const linked = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(linked);
  const project = join(linked, "src", "prj_" + "e".repeat(32));
  file(join(project, "Sources", "A.swift"), 10);
  file(join(project, "Sources", "B.swift"), 10);
  mkdirSync(join(linked, "cache"), { recursive: true });
  symlinkSync(project, join(linked, "cache", "DerivedData"));
  const elsewhere = mkdtempSync(join(tmpdir(), "su-space-elsewhere-"));
  stateCopy(elsewhere, "stored", 10, saved, { usedAt: saved });
  symlinkSync(join(elsewhere, "phone-states"), join(linked, "phone-states"));
  await clearForNoSpace("no_space");
  assert.ok(existsSync(join(project, "Sources", "A.swift")) && existsSync(join(project, "Sources", "B.swift")));
  assert.ok(existsSync(join(elsewhere, "phone-states", "stored", "state.json")));
});

test("what earlier phones' work left half done goes at the mount; a state by such a name stays", async () => {
  volume(20e9);
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  const states = join(ws, "phone-states");
  file(join(states, "a.saving", "data", "x"), 50);
  writeFileSync(join(states, "a.saving", "state.json"), JSON.stringify({ name: "a", saved_at: "2026-10-30T00:00:00.000Z" }));
  file(join(states, ".b.fetching-AbC123", "b", "state.json"), 1);
  const named = stateCopy(ws, "c.saving", 10, "2026-10-30T00:00:00.000Z");
  file(join(ws, "src", ".nomac-upload-Xy12Zq", "archive"), 30);
  file(join(ws, "src", ".nomac-sync", "archive-123-456.tar.gz"), 20);
  const index = join(ws, "src", ".nomac-sync", "prj_" + "f".repeat(32) + ".json");
  file(index, 1);
  file(join(ws, ".nomac-trash", "1-abcd", "x"), 5);
  const stored = stateCopy(ws, "stored", 10, "2026-10-30T00:00:00.000Z", { usedAt: "2026-10-30T00:00:00.000Z" });
  reports.length = 0;
  await mounted(ws);
  assert.deepEqual(readdirSync(states).sort(), ["c.saving", "stored"]);
  assert.ok(existsSync(join(named, "state.json")) && existsSync(join(stored, "state.json")), "with room, no copy goes");
  assert.deepEqual(readdirSync(join(ws, "src")).sort(), [".nomac-sync"]);
  assert.ok(existsSync(index));
  assert.deepEqual(readdirSync(join(ws, ".nomac-trash")), []);
  assert.equal(reports[0]?.leftovers, 5);
  assert.equal(reports[0]?.leftover_bytes, 105 * MIB);
  assert.equal(reports[0]?.states, 0);
});

test("a write that runs out of room clears what may go and runs once more; with nothing to clear it says plainly what to do", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  const stored = stateCopy(ws, "stored", 100, "2026-10-20T10:00:00.000Z", { usedAt: "2026-10-20T10:00:00.000Z" });
  let tries = 0;
  const once = async () => {
    if (++tries === 1) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return "written";
  };
  assert.equal(await retryWithRoom("upload", once), "written");
  assert.equal(tries, 2);
  assert.equal(existsSync(stored), false);
  // Nothing left to clear: the agent reads why and what to do, never "No space left on device".
  await assert.rejects(retryWithRoom("upload", async () => { throw new Error("ditto: /Volumes/x: No space left on device"); }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "workspace_full");
    assert.match(error.message, /^workspace_full: This account's phone workspace is full \(\d+\.\d of its 10\.0 GB in use\), even after NoMac cleared/);
    assert.match(error.message, /\nNext: delete saved states you no longer need with the phone tool's delete_state action \(states lists them\), then try again\.$/);
    assert.doesNotMatch(error.message, /No space left|\/Volumes/);
    return true;
  });
  // Any other failure is the write's own.
  await assert.rejects(retryWithRoom("upload", async () => { throw new Error("upload_checksum_mismatch"); }), /^Error: upload_checksum_mismatch$/);
  for (const said of [Object.assign(new Error("x"), { code: "ENOSPC" }), Object.assign(new Error("x"), { code: "EDQUOT" }), new Error("tar: Write failed: No space left on device"),
    Object.assign(new Error("git fetch: failed"), { stderr: "fatal: write error: No space left on device" }), new Error("ld: write() failed, errno=28"), new Error("Disc quota exceeded")]) {
    assert.ok(noSpace(said), said.message);
  }
  for (const said of [new Error(`workspace_full: ${fullText()}`), new Error("git: no space in the name"), new Error("errno=280")]) assert.ok(!noSpace(said), said.message);
});

test("an upload that cannot fit fails at once and plainly, after the copies that may go have gone", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  file(join(ws, "src", "upload_" + "1".repeat(32), "Old.app", "Old"), 8000);
  const stored = stateCopy(ws, "stored", 500, "2026-10-20T10:00:00.000Z", { usedAt: "2026-10-20T10:00:00.000Z" });
  const localOnly = stateCopy(ws, "local-only", 500, "2026-10-20T10:00:00.000Z");
  const realFetch = globalThis.fetch;
  // A 1.5 GB upload, as its length says; the workspace has about 1.1 GB free once the stored copy has gone.
  globalThis.fetch = (async () => new Response(new Uint8Array(16), { headers: { "content-length": String(1.5e9) } })) as typeof fetch;
  setAnswerWithin(50);
  try {
    let answer: Record<string, unknown>;
    do answer = (await hosted("simulator-use/fetch", { id: `fetch_${"9".repeat(40)}`, url: "https://r2.example.test/get", sha256: "0".repeat(64), name: "big" })) as Record<string, unknown>;
    while (answer.state === "running");
    assert.equal(answer.state, "failed");
    assert.match(String(answer.error), /^workspace_full: This account's phone workspace is full \(8\.9 of its 10\.0 GB in use\)/);
    assert.match(String(answer.error), /delete_state/);
    assert.equal(existsSync(stored), false, "the copy in NoMac's storage went first");
    assert.ok(existsSync(join(localOnly, "state.json")), "the copy kept only here stayed");
    assert.ok(existsSync(join(ws, "src", "upload_" + "1".repeat(32), "Old.app", "Old")), "the account's earlier upload stayed");
    assert.deepEqual(readdirSync(join(ws, "src")).filter((n) => n.startsWith(".nomac-upload-")), [], "the unpack left nothing");
  } finally {
    globalThis.fetch = realFetch;
    setAnswerWithin(8_000);
  }
});

test("a build that runs out of room builds again once the copies and other caches are cleared, its own cache kept", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  const bin = mkdtempSync(join(tmpdir(), "su-space-bin-"));
  const runs = join(bin, "runs");
  // The first build fails deep in the linker, as a full disk does; the next one builds.
  writeFileSync(join(bin, "xcodebuild"), `#!/bin/sh\necho run >> "${runs}"\nif [ "$(wc -l < "${runs}")" -eq 1 ]; then echo "ld: write() failed, errno=28 (No space left on device) for '/x'"; exit 65; fi\necho "** BUILD SUCCEEDED **"\n`);
  chmodSync(join(bin, "xcodebuild"), 0o755);
  const dir = join(ws, "src", "prj_" + "2".repeat(32));
  mkdirSync(join(dir, "App.xcodeproj"), { recursive: true });
  const project = { kind: "project" as const, path: join(dir, "App.xcodeproj"), name: "App", dir };
  const stored = stateCopy(ws, "stored", 100, "2026-10-20T10:00:00.000Z", { usedAt: "2026-10-20T10:00:00.000Z" });
  const other = derivedData(ws, "Other-ffffffffffff", 100, Date.now() - 86_400_000);
  const newest = derivedData(ws, "Newest-999999999999", 100, Date.now() + 60_000);
  const saved = { path: process.env.PATH, clamp: process.env.SIMULATOR_USE_BUILD_CLAMP };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.SIMULATOR_USE_BUILD_CLAMP;
  try {
    const result = await build(project, "App", "5E55E550-0000-4000-8000-000000000001", {});
    assert.equal(result.ok, true, result.tail.join("\n"));
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 2);
    assert.equal(existsSync(stored), false);
    assert.equal(existsSync(other), false);
    assert.equal(existsSync(newest), true);
    // Its own cache, where its logs are, stayed through the clearing.
    assert.equal(readdirSync(join(ws, "cache", "DerivedData")).filter((n) => n.startsWith("App-")).length, 1);
    // Still out of room with nothing to clear: the fix the agent reads is the workspace's.
    assert.match(knownFix([], ["ld: write() failed, errno=28 (No space left on device) for '/x'"]) ?? "", /^the phone's workspace is full, even after NoMac cleared .*delete_state/);
  } finally {
    process.env.PATH = saved.path;
    if (saved.clamp !== undefined) process.env.SIMULATOR_USE_BUILD_CLAMP = saved.clamp;
  }
});

test("a pod install that runs out of room installs again after the clearing", async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  const bin = mkdtempSync(join(tmpdir(), "su-space-pod-"));
  const runs = join(bin, "runs");
  writeFileSync(join(bin, "pod"), `#!/bin/bash\necho run >> "${runs}"\nif [ "$(wc -l < "${runs}")" -eq 1 ]; then echo "[!] Errno::ENOSPC - No space left on device @ rb_sysopen" >&2; exit 1; fi\nmkdir -p App.xcworkspace Pods\nprintf 'PODFILE CHECKSUM: %s\\n' "$(shasum -a 1 Podfile | cut -d' ' -f1)" > Podfile.lock\ncp Podfile.lock Pods/Manifest.lock\n`);
  chmodSync(join(bin, "pod"), 0o755);
  const dir = join(ws, "src", "prj_" + "3".repeat(32));
  mkdirSync(join(dir, "App.xcodeproj"), { recursive: true });
  writeFileSync(join(dir, "App.xcodeproj", "project.pbxproj"), "// pbx\n");
  writeFileSync(join(dir, "Podfile"), "target 'App' do\n  pod 'Foo'\nend\n");
  const stored = stateCopy(ws, "stored", 100, "2026-10-20T10:00:00.000Z", { usedAt: "2026-10-20T10:00:00.000Z" });
  const saved = { pod: process.env.SIMULATOR_USE_POD, state: process.env.SIMULATOR_USE_STATE_DIR };
  process.env.SIMULATOR_USE_POD = join(bin, "pod");
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-space-state-"));
  try {
    const found = await findProject(dir);
    assert.equal(found.kind, "workspace");
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 2);
    assert.equal(existsSync(stored), false);
  } finally {
    for (const [key, value] of [["SIMULATOR_USE_POD", saved.pod], ["SIMULATOR_USE_STATE_DIR", saved.state]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// The phone's side of a save and a restore, with simctl stood in for and ditto, a Mac's, as the host has it.
test("a save kept in NoMac's storage marks its copy as a cache; one only here, or whose upload failed, is never cleared; a restore NoMac sent marks it again", { skip: process.platform !== "darwin" }, async () => {
  volume();
  const ws = mkdtempSync(join(tmpdir(), "su-space-"));
  await mounted(ws);
  const phone = mkdtempSync(join(tmpdir(), "su-space-phone-"));
  file(join(phone, "Library", "Preferences", "app.plist"), 600);
  const bin = mkdtempSync(join(tmpdir(), "su-space-xcrun-"));
  const udid = "5E55E550-0000-4000-8000-000000000001";
  const devices = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid, name: "iPhone 17 Pro", state: "Booted", isAvailable: true, dataPath: phone }] } });
  writeFileSync(join(bin, "devices.json"), devices);
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nif [ "$2" = list ]; then cat "${join(bin, "devices.json")}"; fi\nexit 0\n`);
  chmodSync(join(bin, "xcrun"), 0o755);
  const stored = new Map<string, Buffer>();
  let refuse = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const key = String(url);
    if (init?.method === "PUT") {
      const body = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer());
      if (refuse) return new Response("", { status: 500 });
      stored.set(key.replace("/put/", "/get/"), body);
      return new Response("", { status: 200 });
    }
    const body = stored.get(key);
    return body ? new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } }) : new Response("", { status: 404 });
  }) as typeof fetch;
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  setFirstRead(async () => ({ ok: true }));
  setAnswerWithin(50);
  const dataKey = Buffer.alloc(32, 7).toString("base64url");
  let n = 0;
  const state = async (params: Record<string, unknown>) => {
    const id = `state_${(++n).toString(16).padStart(40, "0")}`;
    let answer: Record<string, unknown>;
    do answer = (await hosted("simulator-use/state", { id, ...params })) as Record<string, unknown>;
    while (answer.state === "running");
    return answer;
  };
  const mark = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(ws, "phone-states", name, STORED), "utf8")) as { saved_at: string; used_at: string };
    } catch {
      return undefined;
    }
  };
  try {
    const kept = await state({ action: "save", name: "signed-in", url: "https://r2.example.test/put/signed-in", data_key: dataKey });
    assert.equal(kept.state, "done", String(kept.error));
    assert.equal(kept.uploaded, true);
    assert.equal(mark("signed-in")?.saved_at, kept.saved_at, "in NoMac's storage: its copy is a cache");
    const here = await state({ action: "save", name: "here-only" });
    assert.equal(here.state, "done", String(here.error));
    assert.equal(mark("here-only"), undefined, "saved without NoMac's storage: kept");
    refuse = true;
    const failed = await state({ action: "save", name: "upload-failed", url: "https://r2.example.test/put/upload-failed", data_key: dataKey });
    refuse = false;
    assert.equal(failed.state, "failed");
    assert.match(String(failed.error), /^saved on this phone, but not kept for other phones/);
    assert.equal(mark("upload-failed"), undefined, "its upload failed: kept");
    // The account's projects fill the workspace: only the copy in NoMac's storage goes.
    file(join(ws, "src", "prj_" + "4".repeat(32), "big"), 6500);
    await ensureRoom("upload");
    assert.deepEqual(readdirSync(join(ws, "phone-states")).sort(), ["here-only", "upload-failed"]);
    // NoMac sends the save on a restore: fetched again and marked again.
    const back = await state({ action: "restore", name: "signed-in", url: "https://r2.example.test/get/signed-in", data_key: dataKey, saved_at: kept.saved_at });
    assert.equal(back.state, "done", String(back.error));
    assert.equal(back.fetched, true);
    assert.equal(mark("signed-in")?.saved_at, kept.saved_at);
    // A state restored without NoMac's storage (saved before states went there) stays unmarked.
    const local = await state({ action: "restore", name: "here-only" });
    assert.equal(local.state, "done", String(local.error));
    assert.equal(mark("here-only"), undefined);
  } finally {
    globalThis.fetch = realFetch;
    process.env.PATH = savedPath;
    setFirstRead(undefined);
    setAnswerWithin(8_000);
  }
});
