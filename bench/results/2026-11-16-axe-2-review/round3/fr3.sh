#!/bin/bash
# The first read after a boot, 0.16.0 (A) against a candidate, 10 trials each, interleaved: right after the boot
# (hostd's way) and 20 s after it with the demo relaunched (round 2's fr-final.sh with the build as an argument).
#   fr3.sh LABEL ENGINE
L=$1; BE=$2; D=~/drive/al; source $D/env.sh
AE=$HOME/drive/ab/A/lib/node_modules/simulator-use/vendor/axe/simulator-use-engine
cd ~/drive/src/simtap
$D/fixrt.sh >/dev/null
xcrun simctl boot "$U" 2>/dev/null; xcrun simctl bootstatus "$U" -b >/dev/null
node bin/simulator-use.js run examples/swiftui-demo --device "$U" > /dev/null 2>&1; echo "demo installed: $?"
pkill -f simulator-use-engine; sleep 20
rm -rf $D/hostd-$L $D/settle20-$L
node bench/first-read.mjs --udid "$U" --out $D/hostd-$L --trials 10 A="$AE" $L="$BE" > $D/hostd-$L.log 2>&1
node bench/first-read.mjs --report $D/hostd-$L >> $D/hostd-$L.log
$D/fixrt.sh
node bench/first-read.mjs --udid "$U" --out $D/settle20-$L --settle 20 --trials 10 A="$AE" $L="$BE" > $D/settle20-$L.log 2>&1
node bench/first-read.mjs --report $D/settle20-$L >> $D/settle20-$L.log
pkill -f simulator-use-engine
tail -4 $D/hostd-$L.log $D/settle20-$L.log
