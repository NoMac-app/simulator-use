#!/bin/bash
# lab.sh (this branch, the repository's own) on each phone in turn, one Simulator at a time, with the engine's session
# log of each run.   lab3.sh LABEL "PHONE" ...
L=$1; shift; D=~/drive/al; cd ~/drive/src/simtap
TMP=$(getconf DARWIN_USER_TEMP_DIR)
for P in "$@"; do
  $D/fixrt.sh >/dev/null; xcrun simctl shutdown all 2>/dev/null; pkill -f simulator-use-engine
  N=$(echo "$P" | tr -cd 'A-Za-z0-9')
  bash scripts/lab.sh "$P" > $D/lab-$L-$N.log 2>&1
  echo "$P: exit $? $(grep -c '^PASS' $D/lab-$L-$N.log) PASS, $(grep -c '^FAIL' $D/lab-$L-$N.log) FAIL: $(grep '^FAIL' $D/lab-$L-$N.log | cut -c6- | tr '\n' ';')"
  U=$(xcrun simctl list devices | grep "$P (" | grep -oE '[0-9A-F-]{36}' | head -1)
  grep -hE "timed out|refused|restarted|no answer" $TMP/simulator-use-engine-$U.log 2>/dev/null | wc -l | sed 's/^/  session log: timeouts or restarts in all runs so far: /'
done
xcrun simctl shutdown all; pkill -f simulator-use-engine; true
