#!/bin/bash
# Does a phone refuse the next session after its test daemons were restarted, with and without a permission alert in
# front? Each step one engine and one read (one-read.mjs), with the phone's own testmanagerd log after.
#   stuck.sh ENGINE LABEL
E=$1; L=$2
source ~/drive/al/env.sh
restart() { for l in com.apple.testmanagerd com.apple.dt.automationmode-writer com.apple.dt.AutomationModeUI; do xcrun simctl spawn "$U" launchctl stop "$l"; done; sleep 2; }
pkill -f simulator-use-engine; sleep 2
xcrun simctl boot "$U" 2>/dev/null; xcrun simctl bootstatus "$U" -b >/dev/null
xcrun simctl location "$U" set 37.3349,-122.0090
xcrun simctl uninstall "$U" dev.simtap.edgelab 2>/dev/null
cd ~/drive/src/simtap && node bin/simulator-use.js run examples/edge-lab --device "$U" > /dev/null 2>&1; pkill -f simulator-use-engine; sleep 3
t0=$(date '+%Y-%m-%d %H:%M:%S')
node ~/drive/al/one-read.mjs "$E" "$U" "$L 1 no alert"
sleep 3; node ~/drive/al/one-read.mjs "$E" "$U" "$L 2 no alert, next engine"
restart; node ~/drive/al/one-read.mjs "$E" "$U" "$L 3 no alert, after a restart of the daemons"
sleep 3; node ~/drive/al/one-read.mjs "$E" "$U" "$L 4 no alert, next engine"
node bin/simulator-use.js act --device "$U" 'tap Dialogs' 'tap "Ask for location"' 'wait "Allow While Using App" 20' 2>&1 | grep -c 'Allow While Using App' | sed "s/^/$L location alert shown: /"
pkill -f simulator-use-engine; sleep 3
node ~/drive/al/one-read.mjs "$E" "$U" "$L 5 alert up"
sleep 3; node ~/drive/al/one-read.mjs "$E" "$U" "$L 6 alert up, next engine"
restart; node ~/drive/al/one-read.mjs "$E" "$U" "$L 7 alert up, after a restart of the daemons"
sleep 3; node ~/drive/al/one-read.mjs "$E" "$U" "$L 8 alert up, next engine"
node bin/simulator-use.js act --device "$U" 'tap "Allow While Using App"' > /dev/null 2>&1; pkill -f simulator-use-engine; sleep 3
node ~/drive/al/one-read.mjs "$E" "$U" "$L 9 alert answered"
sleep 3; node ~/drive/al/one-read.mjs "$E" "$U" "$L 10 alert answered, next engine"
xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate '(process == "testmanagerd" AND (eventMessage CONTAINS "IDE connected" OR eventMessage CONTAINS "for AX to finish" OR eventMessage CONTAINS "kAXAccessibilityLoaded" OR eventMessage CONTAINS "Finished loading AX" OR eventMessage CONTAINS "Failed" OR eventMessage CONTAINS "timed out" OR eventMessage CONTAINS "Tearing down")) OR (process == "launchd_sim" AND eventMessage CONTAINS "testmanagerd")' > ~/drive/al/stuck-$L.phone.log 2>&1
echo "phone log: $(wc -l < ~/drive/al/stuck-$L.phone.log) lines"
pkill -f simulator-use-engine; true
