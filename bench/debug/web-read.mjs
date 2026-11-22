// Experiment: what the Simulator's Web Inspector lists, and what page-script.ts answers for each page it shows.
//   UDID=... node bench/debug/web-read.mjs [--lines N] [--pid PID] [--times N]
import { webInspector } from "../../src/web/inspector.ts";
import { PAGE_SCRIPT } from "../../src/web/page-script.ts";

const udid = process.env.UDID;
if (!udid) { console.error("set UDID"); process.exit(2); }
const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const lines = Number(option("--lines", 60)), times = Number(option("--times", 1));
let t = Date.now();
const inspector = await webInspector(udid);
if (!inspector) { console.error("no Web Inspector on this Simulator"); process.exit(1); }
console.log(`connected and listed in ${Date.now() - t} ms`);
const apps = [...inspector.apps.values()];
for (const app of apps) {
  const pages = inspector.listings.get(app.id) ?? [];
  if (option("--pid") && String(app.pid) !== option("--pid")) continue;
  console.log(`${app.id} ${app.bundleId}${app.host ? ` (for ${app.host})` : ""}${app.proxy ? " proxy" : ""}: ${pages.length} page(s)`);
  for (const page of pages) {
    console.log(`  page ${page.page}: ${JSON.stringify(page.title)} ${page.url}`);
    for (let i = 0; i < times; i++) {
      t = Date.now();
      try {
        const value = await inspector.evaluate(page, PAGE_SCRIPT, 5_000);
        const ms = Date.now() - t;
        const read = JSON.parse(String(value));
        const items = read.items; delete read.items;
        console.log(`  read in ${ms} ms: ${items.length} items ${JSON.stringify(read)}`);
        if (i === 0) for (const item of items.slice(0, lines)) console.log(`    ${item.k.padEnd(11)} ${JSON.stringify(item.n ?? "").slice(0, 56).padEnd(56)} ${item.id ? `#${item.id} ` : ""}@${item.x},${item.y} ${item.w}x${item.h} ${Object.entries(item).filter(([k]) => !"knxywhid".includes(k) && k !== "id").map(([k, v]) => `${k}=${v}`).join(" ")}`);
      } catch (error) {
        console.log(`  failed after ${Date.now() - t} ms: ${error.message}`);
      }
    }
  }
}
inspector.close();
process.exit(0);
