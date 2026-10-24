// Builds simulator-use's native parts into vendor/axe, beside AXe's frameworks, and checks them: the engine
// (native/engine, a persistent Simulator driver) and the clipboard helper (native/pbset, built for the Simulator).
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
// The engine compiles against idb's private headers (never shipped): those of the idb commit AXe 1.8.0 builds its
// frameworks from (AXe's scripts/build.sh), fetched once into node_modules/.cache when IDB_HEADERS is not given.
const IDB_REF = "604c51013438f0c3603b720a05a44b7c5b8f286d";
if (!process.env.IDB_HEADERS) {
  const cache = join(root, "node_modules", ".cache", `idb-${IDB_REF.slice(0, 12)}`);
  if (!existsSync(join(cache, "PrivateHeaders"))) {
    rmSync(cache, { recursive: true, force: true });
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", "https://github.com/cameroncooke/idb.git", cache], { stdio: "inherit" });
    execFileSync("git", ["-C", cache, "checkout", "--quiet", IDB_REF, "--", "PrivateHeaders"], { stdio: "inherit" });
  }
  process.env.IDB_HEADERS = join(cache, "PrivateHeaders");
}
if (!existsSync(process.env.IDB_HEADERS)) throw new Error(`IDB_HEADERS (${process.env.IDB_HEADERS}) does not exist; SIMULATOR_USE_SKIP_NATIVE=1 packs without the native parts`);
const sh = (script) => execFileSync("bash", [script], { cwd: root, stdio: "inherit", env: process.env });
sh(join(root, "native", "engine", "build.sh"));
execFileSync("mv", [join(root, "native", "engine", "simulator-use-engine"), join(vendor, "simulator-use-engine")]);
sh(join(root, "native", "pbset", "build.sh"));
for (const [name, platform] of [["simulator-use-engine", "macOS"], ["simulator-use-pbset", "iOS Simulator"]]) {
  const path = join(vendor, name);
  const info = execFileSync("file", [path], { encoding: "utf8" });
  if (!/Mach-O/.test(info) || !/arm64/.test(info)) throw new Error(`${name} is not an arm64 Mach-O binary: ${info.trim()}`);
  execFileSync("codesign", ["--verify", path]);
  // Executable by everyone whatever the umask: a host may install the package as root for other users to run
  // (0.10.0, packed under umask 077, shipped them as 0700 and NoMac's phone users could not start the engine).
  chmodSync(path, 0o755);
  console.log(`${name}: ${Math.round(statSync(path).size / 1024)} KB, for ${platform}, signed`);
}
