#!/bin/bash
# A second session on a new Mac for the long soak and the extras, from what the drive kept (~/drive/perf): the bench
# Simulator again, the demo and edge-lab apps from their builds on the drive, then a 30-minute soak of build C, a
# benchmark run of C with ui_look's reuse on, and the keyboard preference check with A.
set -uo pipefail
R=~/drive/perf/results; cd ~/drive/perf/repo
RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-27-0
UDID=$(xcrun simctl list devices -j | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin)['devices'].get('$RUNTIME',[]); print(next((x['udid'] for x in d if x['name']=='Bench iPhone 17 Pro'),''))")
[ -n "$UDID" ] || UDID=$(xcrun simctl create "Bench iPhone 17 Pro" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro $RUNTIME)
printf "export UDID=%s\n" $UDID > ~/drive/perf/env.sh
xcrun simctl boot $UDID 2>/dev/null; xcrun simctl bootstatus $UDID -b >/dev/null
xcrun simctl install $UDID ~/drive/perf/dd/Build/Products/Debug-iphonesimulator/Demo.app
xcrun simctl install $UDID ~/drive/perf/dd-lab/Build/Products/Debug-iphonesimulator/EdgeLab.app
xcrun simctl launch $UDID dev.simtap.demo >/dev/null; sleep 20
echo "== soak C ($(date -u +%T))"
node bench/debug/soak.mjs --bin ~/drive/perf/C/bin/simulator-use --udid $UDID --minutes ${SOAK_MINUTES:-30} --out $R/soak-C.jsonl > $R/soak-C.out 2>&1
node bench/debug/soak-report.mjs $R/soak-C.jsonl 5
pkill -f simulator-use-engine; sleep 3
echo "== C with ui_look reuse ($(date -u +%T))"
SIMULATOR_USE_LOOK_REUSE=on BENCH_TOOLS=~/drive/perf/C node bench/run.mjs --tool simulator-use --udid $UDID --out $R/lookreuse --label C-lookreuse 2>&1 | grep -E "quick|FAIL"
echo "== keyboard preference, A ($(date -u +%T))"
bash bench/debug/keyboard-pref.sh ~/drive/perf/A $R/kbpref-A
echo "== done ($(date -u +%T))"
