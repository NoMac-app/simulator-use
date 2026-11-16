#!/bin/bash
# A/B on one Mac, interleaved so drift cancels out: for each round, the benchmark (run.mjs) for each build, the order
# rotated every round (two builds: A B, then B A; three: A B C, B C A, C A B), then optionally the hard cases
# (hard.mjs) for each. A build is a folder with bin/simulator-use (BENCH_TOOLS); the first is A, the next B, C...
# Each run.mjs run reboots the Simulator first, as the published runs do. bench/ab-report.mjs compares them with A.
#   bash bench/ab.sh OUT_DIR ROUNDS A_DIR B_DIR [C_DIR ...] [hard]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: ab.sh OUT_DIR ROUNDS A_DIR B_DIR [C_DIR ...] [hard]}; ROUNDS=${2:?}; shift 2
HARD=""; dirs=()
for a in "$@"; do if [ "$a" = hard ]; then HARD=1; else dirs+=("$a"); fi; done
[ ${#dirs[@]} -ge 2 ] || { echo "usage: ab.sh OUT_DIR ROUNDS A_DIR B_DIR [C_DIR ...] [hard]"; exit 2; }
labels=(A B C D E F G H)
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do
  for k in $(seq 0 $((${#dirs[@]} - 1))); do
    i=$(( (r - 1 + k) % ${#dirs[@]} ))
    x=${labels[$i]}; dir=${dirs[$i]}
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
