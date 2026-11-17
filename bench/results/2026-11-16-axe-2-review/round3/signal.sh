#!/bin/bash
# What a session-free read (ax-probe.mjs) answers in each state of a phone: right after a boot and through the first
# session's accessibility load, after the session closed, after the phone's test daemons were restarted, and with an
# app launched after the last load. The phone's testmanagerd log after.
#   signal.sh ENGINE LABEL
E=$1; L=$2; D=~/drive/al; source $D/env.sh
restart() { for l in com.apple.testmanagerd com.apple.dt.automationmode-writer com.apple.dt.AutomationModeUI; do xcrun simctl spawn "$U" launchctl stop "$l"; done; sleep 2; }
pkill -f simulator-use-engine; sleep 1
xcrun simctl shutdown "$U" 2>/dev/null; xcrun simctl boot "$U"; xcrun simctl bootstatus "$U" -b >/dev/null
t0=$(date '+%Y-%m-%d %H:%M:%S'); echo "$L booted $t0"
node $D/ax-probe.mjs "$E" "$U" 45 1000 "$L boot" &
sleep 5; node $D/one-read.mjs "$E" "$U" "$L first session after the boot"
wait
node $D/ax-probe.mjs "$E" "$U" 3 1000 "$L after the session closed"
restart; node $D/ax-probe.mjs "$E" "$U" 3 1000 "$L after a restart of the daemons"
xcrun simctl launch "$U" com.apple.Preferences >/dev/null; sleep 3
node $D/ax-probe.mjs "$E" "$U" 3 1000 "$L Settings launched after the load"
restart; xcrun simctl terminate "$U" com.apple.Preferences; xcrun simctl launch "$U" com.apple.mobilesafari >/dev/null; sleep 4
node $D/ax-probe.mjs "$E" "$U" 3 1000 "$L Safari launched after a restart"
node $D/one-read.mjs "$E" "$U" "$L session after the restart"
xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate '(process == "testmanagerd" AND (eventMessage CONTAINS "IDE connected" OR eventMessage CONTAINS "load Accessibility" OR eventMessage CONTAINS "for AX to finish" OR eventMessage CONTAINS "kAXAccessibilityLoaded" OR eventMessage CONTAINS "Finished loading AX" OR eventMessage CONTAINS "Failed" OR eventMessage CONTAINS "timed out")) OR (process == "launchd_sim" AND eventMessage CONTAINS "testmanagerd")' 2>&1 | cut -c1-220 > $D/signal-$L.phone.log
echo "phone log: $(wc -l < $D/signal-$L.phone.log) lines"
pkill -f simulator-use-engine; true
