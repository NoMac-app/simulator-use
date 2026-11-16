#!/bin/bash
# lab.sh's "text in any language" step alone, the builds alternating, each on a freshly launched EdgeLab:
#   textcheck.sh UDID ROUNDS NAME=CLI [NAME=CLI ...]
U=$1; N=$2; shift 2
for r in $(seq 1 "$N"); do
  for b in "$@"; do
    name=${b%%=*}; cli=${b#*=}
    pkill -f simulator-use-engine; sleep 1
    xcrun simctl terminate "$U" dev.simtap.edgelab 2>/dev/null; xcrun simctl launch "$U" dev.simtap.edgelab >/dev/null; sleep 3
    out=$($cli act --device "$U" 'tap Text' 'fill #unicode Café 日本 🚀' 'wait "Typed: Café"' 2>&1)
    if grep -q 'Typed: Café 日本 🚀' <<<"$out"; then echo "round $r $name PASS"; else echo "round $r $name FAIL: $(echo "$out" | head -3 | tr '\n' ' ')"; fi
  done
done
pkill -f simulator-use-engine; true
