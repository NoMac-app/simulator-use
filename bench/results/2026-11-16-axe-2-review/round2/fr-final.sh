#!/bin/bash
# The first read after a boot, 0.16.0 (A) against the release candidate (B9), 10 trials each, interleaved, right after
# the boot (hostd's way) and 20 s after it with the demo relaunched; the iPhone 17e stays booted beside.
source ~/drive/al/env.sh
AE=$HOME/drive/ab/A/lib/node_modules/simulator-use/vendor/axe/simulator-use-engine
BE=$HOME/drive/al/B9/simulator-use-engine
cd ~/drive/src/simtap
xcrun simctl boot "$U" 2>/dev/null; xcrun simctl bootstatus "$U" -b >/dev/null
node bin/simulator-use.js run examples/swiftui-demo --device "$U" > /dev/null 2>&1; echo "demo installed: $?"
pkill -f simulator-use-engine; sleep 20
rm -rf ~/drive/al/hostd-B9 ~/drive/al/settle20-B9
node bench/first-read.mjs --udid "$U" --out ~/drive/al/hostd-B9 --trials 10 A="$AE" B9="$BE" > ~/drive/al/hostd-B9.log 2>&1
node bench/first-read.mjs --report ~/drive/al/hostd-B9 >> ~/drive/al/hostd-B9.log
node bench/first-read.mjs --udid "$U" --out ~/drive/al/settle20-B9 --settle 20 --trials 10 A="$AE" B9="$BE" > ~/drive/al/settle20-B9.log 2>&1
node bench/first-read.mjs --report ~/drive/al/settle20-B9 >> ~/drive/al/settle20-B9.log
pkill -f simulator-use-engine
tail -4 ~/drive/al/hostd-B9.log ~/drive/al/settle20-B9.log
