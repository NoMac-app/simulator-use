#!/bin/bash
# Does a paste fail on a new phone's first boot? A new iPhone 17 Pro: EdgeLab installed by run, then lab.sh's fill
# (non-ASCII, so pasted) on the app's first launch, after the app is relaunched, and after the phone is rebooted.
# The phone is deleted after.   paste-first-boot.sh LABEL [run options]
L=$1; shift; D=~/drive/al; cd ~/drive/src/simtap; DL="node bin/simulator-use.js"; APP=dev.simtap.edgelab
fill() { $DL act --device "$N" 'tap Text' 'fill #unicode Café 日本 🚀' 'wait "Typed: Café"' 2>&1 | head -1 | cut -c1-90; }
N=$(xcrun simctl create "Paste $L" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-27-2); echo "$L: new phone $N"
xcrun simctl boot "$N"; xcrun simctl bootstatus "$N" -b >/dev/null
$DL run examples/edge-lab --device "$N" "$@" 2>&1 | tail -1 | cut -c1-80
echo "  first boot, app's first launch: $(fill)"
xcrun simctl terminate "$N" $APP; xcrun simctl launch "$N" $APP >/dev/null; sleep 3
echo "  first boot, app relaunched: $(fill)"
xcrun simctl shutdown "$N"; xcrun simctl boot "$N"; xcrun simctl bootstatus "$N" -b >/dev/null
xcrun simctl launch "$N" $APP >/dev/null; sleep 3
echo "  after a reboot: $(fill)"
pkill -f simulator-use-engine; xcrun simctl shutdown "$N"; xcrun simctl delete "$N"; true
