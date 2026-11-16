#!/bin/bash
# lab.sh on a phone that has a location (so iOS shows the location prompt), with the engine's session log of the run
# and the phone's own log of testmanagerd (what each session request met).
#   lab-loc.sh "PHONE NAME" LABEL [REPO]
NAME=$1; LABEL=$2; REPO=${3:-$HOME/drive/src/simtap}
U=$(xcrun simctl list devices -j | jq -r --arg n "$NAME" '.devices["com.apple.CoreSimulator.SimRuntime.iOS-27-2"][] | select(.name==$n) | .udid' | head -1)
xcrun simctl boot "$U" 2>/dev/null; xcrun simctl bootstatus "$U" -b >/dev/null
xcrun simctl location "$U" set 37.3349,-122.0090
SLOG=$(getconf DARWIN_USER_TEMP_DIR)simulator-use-engine-$U.log
touch "$SLOG"; before=$(wc -l < "$SLOG")
t0=$(date '+%Y-%m-%d %H:%M:%S')
cd "$REPO" && bash scripts/lab.sh "$NAME" > ~/drive/al/lab-$LABEL.log 2>&1
echo "lab $NAME ($LABEL): $(grep -c '^PASS' ~/drive/al/lab-$LABEL.log) PASS, $(grep -c '^FAIL' ~/drive/al/lab-$LABEL.log) FAIL"
grep '^FAIL' ~/drive/al/lab-$LABEL.log
tail -n +$((before + 1)) "$SLOG" | sed 's/^[0-9.]* //' > ~/drive/al/lab-$LABEL.session.log
echo "sessions: $(grep -c 'open ok' ~/drive/al/lab-$LABEL.session.log) ok, $(grep -c 'timed out' ~/drive/al/lab-$LABEL.session.log) timed out, $(grep -c 'waiting for its' ~/drive/al/lab-$LABEL.session.log) waited for a new testmanagerd, $(grep -c 'refused' ~/drive/al/lab-$LABEL.session.log) restarts"
xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate '(process == "testmanagerd" AND (eventMessage CONTAINS[c] "AX" OR eventMessage CONTAINS[c] "IDE connected" OR eventMessage CONTAINS[c] "remote automation" OR eventMessage CONTAINS[c] "Automation Mode" OR eventMessage CONTAINS[c] "Launched" OR eventMessage CONTAINS[c] "error" OR eventMessage CONTAINS[c] "fail")) OR (process == "launchd_sim" AND eventMessage CONTAINS "testmanagerd")' > ~/drive/al/lab-$LABEL.phone.log 2>&1
echo "phone log: $(wc -l < ~/drive/al/lab-$LABEL.phone.log) lines"
pkill -f simulator-use-engine; sleep 2
xcrun simctl shutdown "$U"
