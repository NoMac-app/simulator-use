#!/bin/bash
# A new engine's first read after the phone's test daemons were restarted, per build, interleaved, N trials:
#   plain: nothing else (the phone takes sessions again at once);
#   stuck: the testmanagerd the request starts is stopped (SIGSTOP) as it appears, a daemon that never answers, as
#          on Mac 7 after a recovery restart (November 16, 2026); it is killed once the engine restarts the daemons
#          (its session log says so), as a restart ended it there.
# One line per read; the engine's session log lines with it.
#   stuck-bench.sh plain|stuck N LABEL=ENGINE ...
MODE=$1; N=$2; shift 2
D=~/drive/al; source $D/env.sh
restart() { for l in com.apple.testmanagerd com.apple.dt.automationmode-writer com.apple.dt.AutomationModeUI; do xcrun simctl spawn "$U" launchctl stop "$l"; done; sleep 2; }
LOG=$(getconf DARWIN_USER_TEMP_DIR)simulator-use-engine-$U.log
phone_tm() { pgrep -f 'CoreSimulator.*/testmanagerd|RuntimeRoot.*/testmanagerd' | head -1; }
pkill -f simulator-use-engine; sleep 1
for t in $(seq 1 "$N"); do
  builds=("$@"); k=$(( (t - 1) % ${#builds[@]} )); order=("${builds[@]:k}" "${builds[@]:0:k}")
  for b in "${order[@]}"; do
    L=${b%%=*}; E=${b#*=}
    restart; sleep 3
    if [ "$MODE" = stuck ]; then
      lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
      ( for i in $(seq 1 1500); do p=$(phone_tm); [ -n "$p" ] && { kill -STOP "$p"; break; }; sleep 0.02; done
        for i in $(seq 1 1300); do tail -n +"$((lines + 1))" "$LOG" 2>/dev/null | grep -q 'test daemons restarted' && break; pgrep -f "simulator-use-engine --udid $U" >/dev/null || break; sleep 0.1; done
        [ -n "$p" ] && kill -KILL "$p" 2>/dev/null ) &
      w=$!
    fi
    node $D/one-read.mjs "$E" "$U" "$MODE $t $L"
    [ "$MODE" = stuck ] && { kill $w 2>/dev/null; wait $w 2>/dev/null; p=$(phone_tm); [ -n "$p" ] && kill -CONT "$p" 2>/dev/null; }
    sleep 3
  done
done
pkill -f simulator-use-engine; true
