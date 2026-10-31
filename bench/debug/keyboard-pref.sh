#!/bin/bash
# Is typing slower when the phone keeps its full on-screen keyboard after hardware key presses? The same short soak
# with the keyboard's automatic minimization on (iOS's default once a hardware key was seen) and off, then restored.
#   bash bench/debug/keyboard-pref.sh BUILD_DIR OUT_PREFIX
set -uo pipefail
source ~/drive/perf/env.sh
B=${1:?build dir}; OUT=${2:?out prefix}
cd ~/drive/perf/repo
reboot() { xcrun simctl shutdown $UDID; xcrun simctl boot $UDID; xcrun simctl bootstatus $UDID -b >/dev/null; sleep 15; }
for cfg in minimize full; do
  pkill -f simulator-use-engine; sleep 3
  if [ $cfg = full ]; then xcrun simctl spawn $UDID defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool NO; fi
  reboot
  echo "== $cfg: $(xcrun simctl spawn $UDID defaults read com.apple.keyboard.preferences AutomaticMinimizationEnabled 2>&1)"
  node bench/debug/soak.mjs --bin $B/bin/simulator-use --udid $UDID --minutes 1.5 --out $OUT-$cfg.jsonl >/dev/null 2>&1
  node bench/debug/soak-report.mjs $OUT-$cfg.jsonl 5
done
pkill -f simulator-use-engine; sleep 3
xcrun simctl spawn $UDID defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool YES
reboot
echo "restored: $(xcrun simctl spawn $UDID defaults read com.apple.keyboard.preferences AutomaticMinimizationEnabled 2>&1)"
