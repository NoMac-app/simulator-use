// Builds simulator-use's native parts into vendor/axe, beside AXe's frameworks, and checks them: the engine
// (native/engine, a persistent Simulator driver), the clipboard helper (native/pbset), the StoreKit helper
// (native/skconfig) and the accessibility helper (native/axon), the three built for the Simulator.
// Run by prepack after fetch-axe.mjs, on a Mac with Xcode: a release without the engine would quietly fall back to
// AXe everywhere, so a failed build stops the pack. SIMULATOR_USE_SKIP_NATIVE=1 packs without them (CI's check of
// the package, a local tarball for testing AXe alone).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vendor = join(root, "vendor", "axe");
if (process.env.SIMULATOR_USE_SKIP_NATIVE === "1") {
  console.log("native parts skipped (SIMULATOR_USE_SKIP_NATIVE=1): the package will use AXe alone");
  process.exit(0);
}
if (!existsSync(join(vendor, "Frameworks", "FBSimulatorControl.framework"))) throw new Error("AXe's frameworks are missing from vendor/axe: run scripts/fetch-axe.mjs first");
// The engine compiles against idb's private headers (never shipped). Since AXe 2.0 they live in AXe's own repository
// (Packages/IDBKit/PrivateHeaders), beside the frameworks' sources: those of the commit the pinned release (AXe
// v2.0.4, scripts/fetch-axe.mjs) was built from, fetched once into node_modules/.cache when IDB_HEADERS is not given.
const AXE_COMMIT = "3e4100f6805b78a2b457935afa086e95d1c8cf7d"; // tag v2.0.4
const HEADERS = "Packages/IDBKit/PrivateHeaders";
if (!process.env.IDB_HEADERS) {
  const cache = join(root, "node_modules", ".cache", `axe-${AXE_COMMIT.slice(0, 12)}`);
  if (!existsSync(join(cache, HEADERS))) {
    rmSync(cache, { recursive: true, force: true });
    // That one commit's tree, and only the headers' files (a few hundred KB, not the repository's history).
    const git = (...args) => execFileSync("git", ["-C", cache, ...args], { stdio: "inherit" });
    execFileSync("git", ["init", "--quiet", cache], { stdio: "inherit" });
    git("remote", "add", "origin", "https://github.com/cameroncooke/AXe.git");
    git("fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", AXE_COMMIT);
    git("checkout", "--quiet", AXE_COMMIT, "--", HEADERS);
  }
  process.env.IDB_HEADERS = join(cache, HEADERS);
}
if (!existsSync(process.env.IDB_HEADERS)) throw new Error(`IDB_HEADERS (${process.env.IDB_HEADERS}) does not exist; SIMULATOR_USE_SKIP_NATIVE=1 packs without the native parts`);
const sh = (script) => execFileSync("bash", [script], { cwd: root, stdio: "inherit", env: process.env });
sh(join(root, "native", "engine", "build.sh"));
execFileSync("mv", [join(root, "native", "engine", "simulator-use-engine"), join(vendor, "simulator-use-engine")]);
sh(join(root, "native", "pbset", "build.sh"));
sh(join(root, "native", "skconfig", "build.sh"));
sh(join(root, "native", "axon", "build.sh"));
for (const [name, platform] of [["simulator-use-engine", "macOS"], ["simulator-use-pbset", "iOS Simulator"], ["simulator-use-skconfig", "iOS Simulator"], ["simulator-use-axon", "iOS Simulator"]]) {
  const path = join(vendor, name);
  const info = execFileSync("file", [path], { encoding: "utf8" });
  if (!/Mach-O/.test(info) || !/arm64/.test(info)) throw new Error(`${name} is not an arm64 Mach-O binary: ${info.trim()}`);
  execFileSync("codesign", ["--verify", path]);
  // Executable by everyone whatever the umask: a host may install the package as root for other users to run
  // (0.10.0, packed under umask 077, shipped them as 0700 and NoMac's phone users could not start the engine).
  chmodSync(path, 0o755);
  console.log(`${name}: ${Math.round(statSync(path).size / 1024)} KB, for ${platform}, signed`);
}
