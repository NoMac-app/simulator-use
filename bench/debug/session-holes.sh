#!/bin/bash
# Experiment: the engine's session after what used to break it.   UDID=... bash bench/debug/session-holes.sh
#  1. The phone's test daemon ended under an engine that keeps a session: a newly launched app must still read.
#  2. An engine killed outright (no close): the next one must wait the gap and read.
#  3. A client that goes away mid-request: the engine must close its session, not die of SIGPIPE.
set -uo pipefail
cd "$(dirname "$0")/../.."
LOCK="${TMPDIR:-/tmp/}simulator-use-engine-$UDID.lock"
LOG="${TMPDIR:-/tmp/}simulator-use-engine-$UDID.log"
S="node bin/simulator-use.js"
echo "== 1. test daemon ended under a kept session"
cat > /tmp/holes.txt <<'P'
app_control {"action":"launch","app":"dev.simtap.demo"}
ui_look {}
P
node - <<'N'
import { McpClient } from "./bench/lib/mcp.mjs";
import { execFileSync } from "node:child_process";
const udid = process.env.UDID;
const mcp = new McpClient({ command: process.execPath, args: ["bin/simulator-use.js", "mcp"], env: { SIMULATOR_USE_DEBUG: "on" }, name: "simulator-use", stderrFile: "/tmp/holes.log" });
await mcp.initialize(120000); await mcp.listTools(120000);
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
await mcp.call("device_use", { device: udid }, 180000);
let r = await mcp.call("app_control", { action: "launch", app: "dev.simtap.demo" }, 120000);
console.log("before:", text(r).split("\n").slice(0, 3).join(" / "));
for (const service of ["com.apple.testmanagerd"]) { try { execFileSync("xcrun", ["simctl", "spawn", udid, "launchctl", "stop", service]); } catch (e) { console.log("stop failed", String(e).slice(0, 80)); } }
try { execFileSync("pkill", ["-u", String(process.getuid()), "-x", "testmanagerd"]); } catch {}
await new Promise((res) => setTimeout(res, 1500));
let t = Date.now();
r = await mcp.call("app_control", { action: "launch", app: "dev.simtap.edgelab" }, 120000);
console.log(`after the daemon ended, launch in ${Date.now() - t} ms:`, text(r).split("\n").slice(0, 4).join(" / "));
t = Date.now();
r = await mcp.call("ui_look", {}, 120000);
console.log(`look in ${Date.now() - t} ms:`, text(r).split("\n").slice(0, 3).join(" / "));
await mcp.close?.();
process.exit(0);
N
grep -E "kept session|open |close" "$LOG" | tail -6
echo "== 2. an engine killed outright"
$S look > /dev/null 2>&1 &
sleep 1.2; pkill -9 -u "$(id -u)" -f "simulator-use-engine --udid $UDID" && echo "engine killed"; wait 2>/dev/null
echo "lock file: $(cat "$LOCK")"
t0=$(python3 -c 'import time;print(time.time())')
$S look | head -2
python3 -c "import time;print('look after a killed engine: %.1f s' % (time.time()-$t0))"
echo "lock file: $(cat "$LOCK")"
echo "== 3. a client that goes away mid-request"
$S look > /dev/null 2>&1 &
P=$!; sleep 0.9; kill -9 $P 2>/dev/null; sleep 4
echo "engines still running: $(pgrep -u "$(id -u)" -f "simulator-use-engine --udid $UDID" | wc -l | tr -d ' ')"
echo "lock file: $(cat "$LOCK")"
tail -3 "$LOG"
$S look | head -2
