// The engine's wait for an automation session (native/engine/SessionWait.swift), checked by its Swift test with
// whatever Swift this Mac has: no Simulator and no AXe frameworks needed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

test("a session request is waited for while the phone loads accessibility, and refused once it is loaded and the daemon stays silent", { skip: !swiftc && "no swiftc here" }, () => {
  const engine = fileURLToPath(new URL("../native/engine/", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "su-session-"));
  try {
    execFileSync("xcrun", ["swiftc", "-o", join(dir, "session-test"), join(engine, "SessionWait.swift"), join(engine, "test/session/main.swift")], { stdio: "pipe" });
    const out = spawnSync(join(dir, "session-test"), { encoding: "utf8" });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /all checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
