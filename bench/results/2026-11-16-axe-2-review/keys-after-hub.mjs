// Whether the legacy (Indigo) keyboard still types once dtuhidd runs: an engine started while dtuhidd does not run
// (its Indigo connection made then, so AXe does not refuse keys), types into #email; Device Hub is opened (dtuhidd
// starts); the same engine types into #password; both fields read back.
//   node keys-after-hub.mjs ENGINE UDID [engine args...]
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, ...extra] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, ...extra], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
let id = 0;
const call = async (req) => { child.stdin.write(`${JSON.stringify({ id: ++id, ...req })}\n`); return next(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (tree, key) => { for (const n of Array.isArray(tree) ? tree : [tree]) { if (!n) continue; if (n.AXUniqueId === key) return n; const h = find(n.children ?? [], key); if (h) return h; } return null; };
const center = (n) => ({ x: n.frame.x + n.frame.width / 2, y: n.frame.y + n.frame.height / 2 });
const dtuhidd = () => { try { return execSync("pgrep -x dtuhidd || true", { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
const ready = await next();
console.log("ready", JSON.stringify({ hid: ready.hid, hid_choice: ready.hid_choice, hid_keys: ready.hid_keys, dtuhidd: ready.dtuhidd }), "dtuhidd processes", dtuhidd());
const tree = (await call({ op: "describe" })).tree;
const type = async (field, text) => {
  const t = await call({ op: "tap", ...center(find(tree, field)) });
  await sleep(600);
  const a = await call({ op: "type", text });
  await sleep(800);
  const v = find((await call({ op: "describe" })).tree, field)?.AXValue;
  console.log(field, "tap", t.ok, t.via, "type", a.ok, a.ms, "ms", a.via, a.error ?? "", "value", JSON.stringify(v), "dtuhidd processes", dtuhidd());
};
await type("email", "before@hub.io");
execSync("open -a DeviceHub");
for (let i = 0; i < 30 && dtuhidd() === 0; i++) await sleep(500);
await sleep(8000);
await type("password", "after1");
await type("email", "X");
child.stdin.end();
setTimeout(() => process.exit(0), 3000);
