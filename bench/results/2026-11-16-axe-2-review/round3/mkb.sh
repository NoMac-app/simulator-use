#!/bin/bash
# Builds the engine of ~/drive/src/simtap at axe-2 plus PATCH into ~/drive/al/NAME (with AXe's frameworks beside it).
#   mkb.sh NAME PATCH
set -e
D=~/drive/al; cd ~/drive/src/simtap
git checkout -q -- . && git apply "$2"
npm run native 2>&1 | grep -E 'error|warning: |engine:' | grep -v 'is deprecated' | head -20
node --test test/engine-session.test.ts 2>&1 | grep -E '^ℹ (pass|fail)'
mkdir -p "$D/$1" && cp vendor/axe/simulator-use-engine "$D/$1/" && ln -sfn "$D/B9/Frameworks" "$D/$1/Frameworks"
echo "$1 $(shasum -a 256 "$D/$1/simulator-use-engine" | cut -c1-16)"
