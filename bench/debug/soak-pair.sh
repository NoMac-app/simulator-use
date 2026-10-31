#!/bin/bash
# Two builds' soaks one after the other on the same phone, A then B then A again, MINUTES each: the same Mac in the
# same state, for comparing a long session's numbers between builds.
#   bash bench/debug/soak-pair.sh A_DIR B_DIR OUT_PREFIX [MINUTES]
set -uo pipefail
source ~/drive/perf/env.sh
A=${1:?}; B=${2:?}; OUT=${3:?}; M=${4:-8}
cd ~/drive/perf/repo
for x in A B A2; do
  dir=$A; [ $x = B ] && dir=$B
  pkill -f simulator-use-engine; sleep 3
  echo "== $x ($(date -u +%T))"
  node bench/debug/soak.mjs --bin $dir/bin/simulator-use --udid $UDID --minutes $M --out $OUT-$x.jsonl > /dev/null 2>&1
  node bench/debug/soak-report.mjs $OUT-$x.jsonl $M
done
echo "== done ($(date -u +%T))"
