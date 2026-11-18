#!/usr/bin/env node
// The engine's still pictures (the `still` op, the live view's mode for a browser that cannot play H.264), on a booted
// phone: an engine as the live view starts one (no automation session, utility QoS asked), its ready line advertising
// stills; a still is a JPEG of the screen in use at half its pixels, within the size bound, with a seed; asked again
// with that seed while the screen holds still, the answer is "unchanged" and much cheaper; a scale and quality outside
// their bounds are brought within them. Exits non-zero on any miss. Run by scripts/lab.sh and scripts/duo-lab.mjs.
//   node scripts/still-check.mjs UDID
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const udid = process.argv[2];
if (!udid) { console.error("usage: node scripts/still-check.mjs UDID"); process.exit(2); }
const engine = process.env.SIMULATOR_USE_ENGINE || fileURLToPath(new URL("../vendor/axe/simulator-use-engine", import.meta.url));
const child = spawn(engine, ["--udid", udid, "--no-bootstrap", "--qos", "utility"], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
let id = 0;
const call = async (request) => { child.stdin.write(`${JSON.stringify({ id: ++id, ...request })}\n`); return next(); };
const problems = [];
const ready = await next();
if (!ready.ready) problems.push(`the engine did not start: ${ready.error}`);
if (!ready.stills?.includes("since")) problems.push("the ready line does not advertise stills");
if (ready.qos !== "0x11") problems.push(`the engine did not keep utility QoS (${ready.qos})`);
const shot = await call({ op: "still" });
const jpeg = Buffer.from(shot.jpeg_base64 ?? "", "base64");
const even = (v) => Math.round(v * 0.5);
if (!shot.ok || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) problems.push(`no JPEG: ${shot.error ?? ""}`);
if (shot.bytes > 600_000) problems.push(`a still of ${shot.bytes} bytes`);
if (shot.width !== even(shot.screen.width) || shot.height !== even(shot.screen.height)) problems.push(`a still of ${shot.width}x${shot.height} for a screen of ${shot.screen.width}x${shot.screen.height}`);
// Unchanged while the screen holds still (a clock or a caret may change it once in a while: three tries).
let unchanged;
for (let i = 0; i < 3 && !unchanged; i++) {
  const seed = (await call({ op: "still" })).seed;
  const again = await call({ op: "still", since: seed });
  if (again.unchanged && again.seed === seed && !again.jpeg_base64) unchanged = again;
}
if (!unchanged) problems.push("never answered unchanged for an unchanged screen");
const bounded = await call({ op: "still", scale: 9, quality: -3 });
if (bounded.width !== shot.screen.width || bounded.quality !== 0.1) problems.push(`scale 9 and quality -3 not brought within bounds (${bounded.width}, ${bounded.quality})`);
child.stdin.end();
const summary = `still ${shot.width}x${shot.height} of the ${shot.screen.role} screen, ${shot.bytes} bytes in ${shot.ms} ms; unchanged answered in ${unchanged?.ms ?? "?"} ms`;
if (problems.length) { console.log(`FAIL ${summary}\n  ${problems.join("\n  ")}`); process.exit(1); }
console.log(`stills ok: ${summary}`);
process.exit(0);
