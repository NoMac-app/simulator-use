#!/bin/bash
# One boot, then the scratch engine with a 60 s first-session wait (no restart), and the phone's own log of what its
# XCTest side did meanwhile: when testmanagerd and the automation-mode daemons started, got the request, answered.
source ~/drive/fr/env.sh
pkill -f simulator-use-engine; sleep 1
xcrun simctl shutdown $U; t0=$(date '+%Y-%m-%d %H:%M:%S')
xcrun simctl boot $U; xcrun simctl bootstatus $U -b >/dev/null
echo "boot from $t0 to $(date '+%H:%M:%S')"
node -e '
const { spawn } = require("node:child_process"); const rl = require("node:readline");
const e = spawn(process.argv[1], ["--udid", process.argv[2]], { stdio: ["pipe", "pipe", "ignore"] });
const it = rl.createInterface({ input: e.stdout })[Symbol.asyncIterator]();
(async () => { const t = Date.now(); await it.next(); console.log("engine ready", new Date().toISOString().slice(11, 23));
  e.stdin.write(JSON.stringify({ id: 1, op: "describe" }) + "\n"); const a = JSON.parse((await it.next()).value);
  console.log("first read", a.ok, a.ms, "ms, done", new Date().toISOString().slice(11, 23)); e.stdin.end(); setTimeout(() => process.exit(0), 3000); })();
' ~/drive/fr/X60.sh $U
tail -4 /var/folders/x4/_3_pp5kx43l0frbk4z8rqwgc0000gp/T/simulator-use-engine-$U.log
xcrun simctl spawn $U log show --start "$t0" --style compact --predicate 'process == "testmanagerd" OR process BEGINSWITH "automationmode" OR process == "AutomationModeUI" OR (process == "launchd_sim" AND eventMessage CONTAINS[c] "testmanagerd")' > ~/drive/fr/why-phone.log 2>&1
wc -l ~/drive/fr/why-phone.log
grep -n "" ~/drive/fr/why-phone.log | awk 'NR<=40' | cut -c1-230
