import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ToolError } from "../src/errors.ts";
import { ensurePackages, packageArgs, packagesCurrent, packagesDirFor, pickScheme, resolvedFile, resolvedPins, type Project } from "../src/engine/xcode.ts";

const pin = (identity: string, revision: string) => ({ identity, kind: "remoteSourceControl", location: `https://github.com/x/${identity}`, state: { revision, version: "1.0.0" } });

/** A project folder with an .xcodeproj naming remote packages, and its Package.resolved when pins are given. */
function projectWith(pins?: { identity: string; revision: string }[]): Project {
  const dir = mkdtempSync(join(tmpdir(), "su-packages-"));
  const path = join(dir, "App.xcodeproj");
  mkdirSync(join(path, "project.xcworkspace", "xcshareddata", "swiftpm"), { recursive: true });
  writeFileSync(join(path, "project.pbxproj"), "/* Begin XCRemoteSwiftPackageReference section */\n");
  const project: Project = { kind: "project", path, name: "App", dir };
  if (pins) writeFileSync(resolvedFile(project), JSON.stringify({ pins: pins.map((p) => pin(p.identity, p.revision)), version: 3 }));
  return project;
}

/** What a resolution leaves in the packages folder: SwiftPM's state and each checkout. */
function checkedOut(dir: string, deps: { identity: string; revision: string; subpath: string }[]) {
  for (const d of deps) mkdirSync(join(dir, "checkouts", d.subpath), { recursive: true });
  writeFileSync(join(dir, "workspace-state.json"), JSON.stringify({ version: 7, object: { artifacts: [], dependencies: deps.map((d) => ({
    packageRef: { identity: d.identity, kind: "remoteSourceControl", location: `https://github.com/x/${d.subpath}`, name: d.subpath },
    state: { checkoutState: { revision: d.revision, version: "1.0.0" }, name: "sourceControlCheckout" }, subpath: d.subpath })) } }));
}

async function withSettings<T>(settings: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(settings)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await work();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("Package.resolved reads in its versions 1 to 3, by the identity SwiftPM gives each package", () => {
  assert.deepEqual(resolvedPins(JSON.stringify({ pins: [pin("rxswift", "9dca")], version: 2 })), [{ identity: "rxswift", revision: "9dca" }]);
  assert.deepEqual(resolvedPins(JSON.stringify({ object: { pins: [{ package: "RxSwift", repositoryURL: "https://github.com/ReactiveX/RxSwift.git", state: { revision: "9dca", version: "6.6.0" } }] }, version: 1 })),
    [{ identity: "rxswift", revision: "9dca" }]);
  assert.equal(resolvedPins("not json"), undefined);
});

test("packages are current only when every pin is checked out at its revision in the kept folder", async () => {
  await withSettings({ SIMULATOR_USE_CACHE_DIR: mkdtempSync(join(tmpdir(), "su-cache-")) }, async () => {
    const project = projectWith([{ identity: "rxswift", revision: "aaa" }, { identity: "snapkit", revision: "bbb" }]);
    const dir = packagesDirFor(project);
    assert.match(dir, /\/DerivedData\/App-[0-9a-f]{12}\/SourcePackages$/, "where the build's own -derivedDataPath keeps them");
    assert.equal(packagesCurrent(project, dir), false, "nothing fetched yet");
    checkedOut(dir, [{ identity: "rxswift", revision: "aaa", subpath: "RxSwift" }]);
    assert.equal(packagesCurrent(project, dir), false, "one package missing");
    checkedOut(dir, [{ identity: "rxswift", revision: "aaa", subpath: "RxSwift" }, { identity: "snapkit", revision: "old", subpath: "SnapKit" }]);
    assert.equal(packagesCurrent(project, dir), false, "Package.resolved moved one on");
    checkedOut(dir, [{ identity: "rxswift", revision: "aaa", subpath: "RxSwift" }, { identity: "snapkit", revision: "bbb", subpath: "SnapKit" }]);
    assert.equal(packagesCurrent(project, dir), true);
    // Every read and the build use that folder; only then are the remotes not asked for updates.
    assert.deepEqual(packageArgs(project), ["-clonedSourcePackagesDirPath", dir, "-scmProvider", "system", "-skipPackageUpdates"]);
    // On NoMac's phone host: no SwiftPM cache in the home that is wiped after the phone, no keychain.
    await withSettings({ SIMULATOR_USE_HOSTED: "1" }, async () => {
      assert.deepEqual(packageArgs(project), ["-clonedSourcePackagesDirPath", dir, "-scmProvider", "system", "-disablePackageRepositoryCache", "-packageAuthorizationProvider", "netrc", "-skipPackageUpdates"]);
    });
    assert.equal(packagesCurrent(projectWith(), dir), false, "a project with packages but no Package.resolved yet");
  });
});

/** A stand-in xcodebuild first on PATH: it records its arguments and does what script says. */
function fakeXcodebuild(script: string): { bin: string; calls: string } {
  const bin = mkdtempSync(join(tmpdir(), "su-xcodebuild-"));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "xcodebuild"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n${script}\n`);
  chmodSync(join(bin, "xcodebuild"), 0o755);
  return { bin, calls };
}

test("a project's packages are fetched once, with each one in the job's progress, and not again while current", async () => {
  const cache = mkdtempSync(join(tmpdir(), "su-cache-"));
  const project = projectWith([{ identity: "rxswift", revision: "aaa" }, { identity: "snapkit", revision: "bbb" }]);
  const dir = (() => {
    process.env.SIMULATOR_USE_CACHE_DIR = cache;
    try {
      return packagesDirFor(project);
    } finally {
      delete process.env.SIMULATOR_USE_CACHE_DIR;
    }
  })();
  // As xcodebuild -resolvePackageDependencies does: each package's fetch, then its checkout and SwiftPM's state.
  const state = JSON.stringify({ version: 7, object: { dependencies: [
    { packageRef: { identity: "rxswift" }, state: { checkoutState: { revision: "aaa" } }, subpath: "RxSwift" },
    { packageRef: { identity: "snapkit" }, state: { checkoutState: { revision: "bbb" } }, subpath: "SnapKit" }] } });
  const fake = fakeXcodebuild(`case "$1" in -resolvePackageDependencies)
echo "Resolve Package Graph"; echo "Fetching from https://github.com/ReactiveX/RxSwift"; echo "Fetching from https://github.com/SnapKit/SnapKit.git"
mkdir -p "${dir}/checkouts/RxSwift" "${dir}/checkouts/SnapKit"; printf '%s' '${state}' > "${dir}/workspace-state.json" ;;
-list) echo '{"project":{"schemes":["App"]}}' ;; esac`);
  await withSettings({ PATH: `${fake.bin}:${process.env.PATH}`, SIMULATOR_USE_CACHE_DIR: cache, SIMULATOR_USE_BUILD_CLAMP: undefined }, async () => {
    const steps: string[] = [];
    const lines: string[] = [];
    const progress = { step: (s: string) => steps.push(s), line: (l: string) => lines.push(l), setCancel: () => {} };
    const note = await ensurePackages(project, progress);
    assert.match(note!, /^Fetched 2 Swift packages in \d+\.\d s; later builds reuse them\.$/);
    assert.deepEqual(steps, ["fetching 2 Swift packages (once: later builds reuse them)",
      "fetching 2 Swift packages (1 of 2: RxSwift; once: later builds reuse them)", "fetching 2 Swift packages (2 of 2: SnapKit; once: later builds reuse them)"]);
    assert.ok(lines.includes("Fetching from https://github.com/ReactiveX/RxSwift"));
    const fetch = readFileSync(fake.calls, "utf8").trim().split("\n");
    assert.equal(fetch.length, 1);
    assert.equal(fetch[0], `-resolvePackageDependencies -project ${project.path} -clonedSourcePackagesDirPath ${dir} -scmProvider system`);
    // Current now: no second fetch, and the scheme is read from the same folder without asking the remotes.
    assert.equal(await ensurePackages(project, progress), undefined);
    assert.equal(await pickScheme(project), "App");
    const calls = readFileSync(fake.calls, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.equal(calls[1], `-list -json -project ${project.path} -clonedSourcePackagesDirPath ${dir} -scmProvider system -skipPackageUpdates`);
  });
});

test("a fetch that fails says what failed, where the log is and what to do", async () => {
  const project = projectWith([{ identity: "private-kit", revision: "aaa" }]);
  const fake = fakeXcodebuild(`echo "Fetching from https://github.com/acme/private-kit"; echo "xcodebuild: error: Could not resolve package dependencies:" >&2; echo "  Failed to clone repository https://github.com/acme/private-kit: fatal: could not read Username" >&2; exit 74`);
  await withSettings({ PATH: `${fake.bin}:${process.env.PATH}`, SIMULATOR_USE_CACHE_DIR: mkdtempSync(join(tmpdir(), "su-cache-")), SIMULATOR_USE_BUILD_CLAMP: undefined }, async () => {
    await assert.rejects(ensurePackages(project), (error: ToolError) => {
      assert.match(error.message, /^Fetching the project's Swift packages failed after \d+\.\d s\. Full log: \/.*\/packages-\d+\.log\n/);
      assert.match(error.message, /Failed to clone repository https:\/\/github\.com\/acme\/private-kit/);
      assert.match(error.next ?? "", /^Check that each package's repository .* packages already fetched are kept\.$/);
      return true;
    });
  });
});

test("a project without Swift packages fetches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-nopackages-"));
  mkdirSync(join(dir, "App.xcodeproj"));
  writeFileSync(join(dir, "App.xcodeproj", "project.pbxproj"), "/* no packages */\n");
  const fake = fakeXcodebuild("exit 1");
  await withSettings({ PATH: `${fake.bin}:${process.env.PATH}` }, async () => {
    assert.equal(await ensurePackages({ kind: "project", path: join(dir, "App.xcodeproj"), name: "App", dir }), undefined);
  });
  assert.throws(() => readFileSync(fake.calls), "xcodebuild never ran");
});
