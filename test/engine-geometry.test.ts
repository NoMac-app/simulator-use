// The engine's screen geometry, screen event line and still counter (native/engine/Geometry.swift, Stills.swift), checked by its Swift test with
// whatever Swift this Mac has: no Simulator and no AXe frameworks needed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

test("the engine turns a screen's buffer, touches and boxes as the guest draws it, tells screen events in the contract's form, and counts stills", { skip: !swiftc && "no swiftc here" }, () => {
  const engine = fileURLToPath(new URL("../native/engine/", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "su-geometry-"));
  try {
    execFileSync("xcrun", ["swiftc", "-o", join(dir, "geometry-test"), join(engine, "Geometry.swift"), join(engine, "Stills.swift"), join(engine, "test/geometry/main.swift")], { stdio: "pipe" });
    const out = spawnSync(join(dir, "geometry-test"), { encoding: "utf8" });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /all checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
