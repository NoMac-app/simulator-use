// Experiment (not part of the benchmark): do AXe's single-process taps stop reaching the app after many screen reads
// on iOS 27? For N in 2 and 20: boot the Simulator again, read the screen N times with `axe describe-ui`, then tap
// Sign In 3 times (each on a fresh app) and check the app's own log for each tap.
import { spawnSync } from "node:child_process";
import { AppLog, killMatching, reboot, resetApp, sleep } from "../lib/sim.mjs";
const udid = process.env.UDID, BUNDLE = "dev.simtap.demo";
const axe = (...a) => { const t = Date.now(); const r = spawnSync("axe", [...a, "--udid", udid], { encoding: "utf8" }); return { ms: Date.now() - t, code: r.status, out: (r.stdout + r.stderr).trim().slice(0, 120) }; };
for (const n of (process.env.AXE_TAPS_N ?? "2,20,2").split(",").map(Number)) {
  killMatching(["hid-broker", "axe describe-ui", "axe tap"]);
  await reboot(udid);
  await resetApp(udid, BUNDLE, 3000);
  const log = new AppLog(udid, BUNDLE); await sleep(1500);
  const reads = []; for (let i = 0; i < n; i++) reads.push(axe("describe-ui").code);
  const taps = [];
  for (let i = 0; i < 3; i++) {
    await resetApp(udid, BUNDLE);
    const mark = log.mark();
    const r = axe("tap", "--id", "signIn");
    taps.push({ ms: r.ms, code: r.code, landed: Boolean(await log.waitFor(/sign-in rejected/, mark, 5000)), out: r.out });
  }
  log.stop();
  console.log(JSON.stringify({ readsBefore: n, readExitCodes: reads.join(""), taps }));
}
process.exit(0);
