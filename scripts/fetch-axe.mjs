// Downloads the pinned AXe release into vendor/axe and checks its SHA-256.
// AXe (MIT, github.com/cameroncooke/AXe) reads the Simulator's accessibility tree and sends input.
// It ships inside the npm package, so the tool never downloads anything at runtime.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.0.4";
const SHA256 = "3178ec66d9ff46455fec737debad719c41cab16edb1435b2c721e07760a208c3";
const RELEASE = `https://github.com/cameroncooke/AXe/releases/download/v${VERSION}/AXe-macOS-v${VERSION}-universal.tar.gz`;

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "vendor", "axe");
const stamp = join(target, ".version");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
  console.log(`AXe ${VERSION} already in vendor/axe`);
  process.exit(0);
}

const response = await fetch(RELEASE);
if (!response.ok) throw new Error(`AXe download failed: HTTP ${response.status} from ${RELEASE}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== SHA256) throw new Error(`AXe checksum mismatch: expected ${SHA256}, got ${digest}`);

const file = join(tmpdir(), `axe-${VERSION}-${process.pid}.tar.gz`);
writeFileSync(file, archive);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
execFileSync("tar", ["-xzf", file, "-C", target]);
rmSync(file);
writeFileSync(stamp, `${VERSION}\n`);
console.log(`AXe ${VERSION} placed in vendor/axe (sha256 ${digest.slice(0, 12)})`);
