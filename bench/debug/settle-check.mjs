#!/usr/bin/env node
// Does settle_read ever answer while the screen is still changing? Each action goes through the engine's settle_read,
// then the screen is watched for a second: any change after the answer that is not a caret's blink means the settle
// answered early. Also prints the plain reads' keep decisions, and whether a read is given again.
//   node bench/debug/settle-check.mjs ENGINE_PATH UDID [rounds]
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [enginePath, udid, rounds = "3"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(enginePath, ["--udid", udid], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
const call = async (req) => { const t = Date.now(); child.stdin.write(JSON.stringify(req) + "\n"); const a = JSON.parse((await lines.next()).value); a.rtt = Date.now() - t; return a; };
const launch = async (bundle) => {
  try { execFileSync("xcrun", ["simctl", "terminate", udid, bundle], { stdio: "ignore" }); } catch {}
  execFileSync("xcrun", ["simctl", "launch", udid, bundle], { stdio: "ignore" });
  await sleep(2500);
};
const nodes = (tree) => { const out = []; const walk = (n) => { for (const x of [n].flat()) { out.push(x); walk(x.children ?? []); } }; walk(tree); return out; };
const find = (tree, f) => nodes(tree).find(f);
const center = (n) => [n.frame.x + n.frame.width / 2, n.frame.y + n.frame.height / 2];
const fields = (tree) => nodes(tree).filter((n) => ["AXTextField", "AXTextArea", "AXSearchField"].includes(n.role) && n.frame).map((n) => n.frame);
let early = 0, total = 0;
/** settle_read with an input, then a second's watch: changes after it that are not a caret in a field. */
const check = async (name, input, extra = {}) => {
  const a = await call({ op: "settle_read", lean: true, first_change_ms: 800, quiet_ms: 150, start_ms: 50, guard_ms: 35, timeout_ms: 4000, ...(input ? { input } : {}), ...extra });
  if (!a.ok) { console.log(`${name}: error ${a.error}`); return a; }
  const w = await call({ op: "watch", window_ms: 1000 });
  const zones = fields(a.tree);
  const after = (w.changes ?? []).filter(([t, x, y, wd, h]) => !(x !== undefined && wd <= 4.5 && h <= 60 && zones.some((z) => x >= z.x - 4 && y >= z.y - 4 && x + wd <= z.x + z.width + 4 && y + h <= z.y + z.height + 4)));
  const moving = after.filter((c) => c.length > 1);
  total++;
  if (moving.length && a.settled !== false) early++;
  console.log(`${name}: ${a.rtt} ms, settled ${a.settled}, first change ${a.first_change_ms} ms, reads ${a.reads} (${(a.read_ms ?? []).join("+")} ms), dropped ${a.dropped}, kept ${a.kept}${moving.length ? `; CHANGED AFTER: ${JSON.stringify(moving.slice(0, 4))}${moving.length > 4 ? ` +${moving.length - 4}` : ""}` : "; still after"}`);
  return a;
};
for (let r = 0; r < Number(rounds); r++) {
  console.log(`== round ${r}`);
  await launch("dev.simtap.demo");
  const d0 = await call({ op: "describe", lean: true });
  const d1 = await call({ op: "describe", lean: true });
  const d2 = await call({ op: "describe", lean: true, reuse: true });
  console.log(`reads after launch: ${d0.rtt} ms (kept ${d0.kept}, still ${d0.still_ms} ms), ${d1.rtt} ms (kept ${d1.kept}, still ${d1.still_ms} ms), reuse: ${d2.rtt} ms (${d2.reused ?? `afresh: ${d2.not_reused}`})`);
  let s = await check("tap Sign In", { op: "tap", x: 201, y: 350 });
  const again = await call({ op: "describe", lean: true, reuse: true });
  console.log(`  read after it: ${again.rtt} ms (${again.reused ?? `afresh: ${again.not_reused}; kept ${again.kept}`})`);
  s = await check("tap Email", { op: "tap", x: 201, y: 194 });
  s = await check("type", { op: "steps", steps: [{ type: "gary@example.com" }] });
  const r2 = await call({ op: "describe", lean: true, reuse: true });
  console.log(`  read after typing: ${r2.rtt} ms (${r2.reused ?? `afresh: ${r2.not_reused}; kept ${r2.kept}, still ${r2.still_ms} ms`})`);
  s = await check("tap Password", { op: "tap", x: 201, y: 246 });
  s = await check("type password", { op: "steps", steps: [{ type: "secret1" }] });
  s = await check("tap Sign In (Password focused)", { op: "tap", x: 201, y: 350 });
  const r3 = await call({ op: "describe", lean: true, reuse: true });
  console.log(`  read after it: ${r3.rtt} ms (${r3.reused ?? `afresh: ${r3.not_reused}; kept ${r3.kept}`})`);
  s = await check("tap Items tab", { op: "tap", x: 244, y: 822 });
  const item = find(s.tree, (n) => n.AXLabel === "Item 1" && n.frame);
  if (item) s = await check("push Item 1", { op: "tap", x: center(item)[0], y: center(item)[1] });
  const back = find(s.tree, (n) => n.role_description === "back button" && n.frame);
  if (back) s = await check("back", { op: "tap", x: center(back)[0], y: center(back)[1] });
  s = await check("scroll the list", { op: "drag", x1: 201, y1: 600, x2: 201, y2: 250, duration: 1.2 });
  s = await check("tap Login tab", { op: "tap", x: 158, y: 822 });
  s = await check("nothing (no input)", null);
  // edge-lab: an alert, a sheet, the ticker
  await launch("dev.simtap.edgelab");
  let lab = await call({ op: "describe", lean: true });
  const dialogs = find(lab.tree, (n) => n.AXLabel === "Dialogs" && n.frame);
  if (dialogs) lab = await check("lab: Dialogs tab", { op: "tap", x: center(dialogs)[0], y: center(dialogs)[1] });
  const show = find(lab.tree, (n) => n.AXLabel === "Show alert" && n.frame);
  if (show) lab = await check("lab: show alert", { op: "tap", x: center(show)[0], y: center(show)[1] });
  const cancel = find(lab.tree, (n) => n.AXLabel === "Cancel" && n.frame);
  if (cancel) lab = await check("lab: cancel alert", { op: "tap", x: center(cancel)[0], y: center(cancel)[1] });
  const sheet = find(lab.tree, (n) => n.AXLabel === "Show sheet" && n.frame);
  if (sheet) lab = await check("lab: show sheet", { op: "tap", x: center(sheet)[0], y: center(sheet)[1] });
  const done = find(lab.tree, (n) => n.AXLabel === "Done" && n.frame);
  if (done) lab = await check("lab: close sheet", { op: "tap", x: center(done)[0], y: center(done)[1] });
}
console.log(`answered while the screen still changed (not counting timeouts): ${early} of ${total}`);
child.stdin.end();
await sleep(1500);
process.exit(0);
