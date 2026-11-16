#!/bin/bash
# With an iOS permission alert in front and not answered (EdgeLab's contacts prompt), what each new simulator-use
# command does: its time and first lines, the engine's session log, and the phone's own log of testmanagerd and
# launchd_sim (who starts testmanagerd, whether it got the request, what it waited for).
#   alert-probe.sh UDID LABEL CLI [COMMANDS] [PROMPT]
U=$1; LABEL=$2; CLI=$3; N=${4:-3}; PROMPT=${5:-Ask for contacts}
TMP=$(getconf DARWIN_USER_TEMP_DIR)
SLOG=$TMP/simulator-use-engine-$U.log
OUT=~/drive/al/$LABEL; mkdir -p "$OUT"
pkill -f simulator-use-engine; sleep 3
xcrun simctl privacy "$U" reset all dev.simtap.edgelab 2>/dev/null
xcrun simctl terminate "$U" dev.simtap.edgelab 2>/dev/null; xcrun simctl launch "$U" dev.simtap.edgelab >/dev/null; sleep 3
before=$(wc -l < "$SLOG" 2>/dev/null || echo 0)
t0=$(date '+%Y-%m-%d %H:%M:%S')
echo "== $LABEL: the alert ($PROMPT), at $t0"
s=$(date +%s); $CLI act --device "$U" 'tap Dialogs' "tap \"$PROMPT\"" > "$OUT/act.txt" 2>&1; echo "act exit $? in $(( $(date +%s) - s )) s: $(head -3 "$OUT/act.txt" | tr '\n' ' ')"
for i in $(seq 1 "$N"); do
  s=$(date +%s); $CLI look --device "$U" > "$OUT/look-$i.txt" 2>&1; rc=$?
  echo "look $i: exit $rc in $(( $(date +%s) - s )) s: $(head -2 "$OUT/look-$i.txt" | tr '\n' ' ' | cut -c1-200)"
done
echo "-- session log"; tail -n +$((before + 1)) "$SLOG" | sed 's/^[0-9.]* //' | tee "$OUT/session.log"
xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate '(process == "testmanagerd" AND (eventMessage CONTAINS[c] "AX" OR eventMessage CONTAINS[c] "Accessibility" OR eventMessage CONTAINS[c] "connected" OR eventMessage CONTAINS[c] "session" OR eventMessage CONTAINS[c] "Automation Mode" OR eventMessage CONTAINS[c] "Launched")) OR (process == "launchd_sim" AND eventMessage CONTAINS "testmanagerd")' > "$OUT/phone.log" 2>&1
echo "-- phone: $(wc -l < "$OUT/phone.log") lines"; grep -E "spawned testmanagerd|exited|Beginning AX|Waiting .* for AX|kAXAccessibilityLoaded|Finished loading AX|Failed|timed out|IDE connected|Handling a remote automation" "$OUT/phone.log" | cut -c1-200 | head -40
pkill -f simulator-use-engine; true
