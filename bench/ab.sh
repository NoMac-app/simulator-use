#!/bin/bash
# A/B on one Mac, interleaved so drift cancels out: for each round, the benchmark (run.mjs) for build A, then B
# (alternating which goes first), then optionally the hard cases (hard.mjs) for each. A build is a folder with
# bin/simulator-use (BENCH_TOOLS). Each run.mjs run reboots the Simulator first, as the published runs do.
#   bash bench/ab.sh OUT_DIR ROUNDS A_DIR B_DIR [hard]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: ab.sh OUT_DIR ROUNDS A_DIR B_DIR [hard]}; ROUNDS=${2:?}; A=${3:?}; B=${4:?}; HARD=${5:-}
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do
  if [ $((r % 2)) -eq 1 ]; then order="A B"; else order="B A"; fi
  for x in $order; do
    dir=$A; [ "$x" = B ] && dir=$B
    echo "=================== round $r build $x ($(date -u +%T))"
    BENCH_TOOLS=$dir node "$HERE/run.mjs" --tool simulator-use --udid "$UDID" --out "$OUT" --label "$x.r$r" 2>&1 | tee "$OUT/simulator-use.$x.r$r.log" | grep -E "quick|FAIL|FATAL"
    if [ -n "$HARD" ]; then
      echo "------------------- hard cases, round $r build $x ($(date -u +%T))"
      pkill -f simulator-use-engine; sleep 3
      node "$HERE/hard.mjs" --bin "$dir/bin/simulator-use" --udid "$UDID" --out "$OUT/hard.$x.r$r.json" --times "${HARD_TIMES:-3}" 2>&1 | tee "$OUT/hard.$x.r$r.log" | grep -E "FAIL|^\{"
      pkill -f simulator-use-engine; sleep 3
    fi
  done
done
echo "=================== done ($(date -u +%T))"
