#!/bin/bash
# Runs tools one at a time on the Simulator setup.sh prepared. Each run reboots the Simulator first.
#   source ~/bench-tools/env.sh && bash bench/run-all.sh bench/results/$(date -u +%F) [entry ...]
# An entry is a tool, or tool@label for a second run of it (files <tool>.<label>.*); a label with "devicehub" in it
# runs with Device Hub open.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: run-all.sh OUT_DIR [entry ...]}
shift
ENTRIES=${*:-simulator-use axe mobilebuildmcp mobile-mcp agent-device argent maestro xcode-mcp ios-simulator-mcp simulator-use@last axe@devicehub mobilebuildmcp@devicehub axe@control mobilebuildmcp@control}
mkdir -p "$OUT"
for e in $ENTRIES; do
  t=${e%%@*}; l=""; [ "$e" != "$t" ] && l=${e#*@}
  extra=(); [ -n "$l" ] && extra+=(--label "$l"); [[ "$l" == *devicehub* ]] && extra+=(--devicehub)
  base=$t; [ -n "$l" ] && base="$t.$l"
  echo "=================== $e"
  node "$HERE/run.mjs" --tool "$t" --udid "$UDID" --out "$OUT" ${extra[@]+"${extra[@]}"} 2>&1 | tee "$OUT/$base.log"
done
