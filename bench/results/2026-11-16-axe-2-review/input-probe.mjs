// Taps and typing through the engine, at the engine: on the demo's sign-in screen, tap the email field, type into it,
// read it back; the same for the password field; then 10 taps on the screen's title (no change). Each input's time and
// the way it went (the answer's via), the ready line's input fields, and whether the text arrived.
//   node input-probe.mjs ENGINE UDID [engine args...]       (SIMULATOR_USE_ENGINE_HID picks the engine's way in)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [engine, udid, ...extra] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, ...extra], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
let id = 0;
const call = async (req) => { child.stdin.write(`${JSON.stringify({ id: ++id, ...req })}\n`); return next(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (tree, key) => {
  for (const n of Array.isArray(tree) ? tree : [tree]) {
    if (!n) continue;
    if (n.AXUniqueId === key) return n;
    const hit = find(n.children ?? [], key);
    if (hit) return hit;
  }
  return null;
};
const center = (n) => ({ x: n.frame.x + n.frame.width / 2, y: n.frame.y + n.frame.height / 2 });
const t0 = Date.now();
const ready = await next();
const out = { ready: { ms: Date.now() - t0, hid: ready.hid, hid_choice: ready.hid_choice, hid_keys: ready.hid_keys, dtuhidd: ready.dtuhidd, hid_ms: ready.hid_ms }, steps: [] };
const step = (name, a, extra = {}) => { out.steps.push({ name, ok: a.ok, ms: a.ms, via: a.via, dtuhid_connect_ms: a.dtuhid_connect_ms, error: a.error, ...extra }); };
try {
  const tree = (await call({ op: "describe" })).tree;
  for (const [field, text] of [["email", "gary@example.com"], ["password", "secret1"]]) {
    const node = find(tree, field);
    if (!node) throw new Error(`no #${field} on screen`);
    step(`tap #${field}`, await call({ op: "tap", ...center(node) }));
    await sleep(600);
    step(`type into #${field}`, await call({ op: "type", text }));
    await sleep(600);
    const after = find((await call({ op: "describe" })).tree, field);
    out.steps[out.steps.length - 1].value = after?.AXValue ?? null;
    out.steps[out.steps.length - 1].arrived = field === "password" ? (after?.AXValue ?? "").length === text.length : after?.AXValue === text;
  }
  const title = find(tree, "signIn") ?? find(tree, "email");
  const point = { x: 20, y: 120 };
  const taps = [];
  for (let i = 0; i < 10; i++) { const a = await call({ op: "tap", ...point }); taps.push(a.ms); if (!a.ok) step("tap", a); await sleep(150); }
  out.taps = { ms: taps, via: (await call({ op: "tap", ...point })).via };
  void title;
} catch (error) {
  out.error = String(error.message ?? error);
}
console.log(JSON.stringify(out));
child.stdin.end();
setTimeout(() => process.exit(0), 3000);
