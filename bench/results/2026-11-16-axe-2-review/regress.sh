#!/bin/bash
# golden.sh on an iPhone 17 Pro and a Pro Max and lab.sh on the iPhone 17 Pro, headless (no Device Hub), with the
# branch's build in ~/drive/src/simtap (its vendor/axe engine), each phone shut down after its runs.
cd ~/drive/src/simtap || exit 1
echo "engine $(shasum -a 256 vendor/axe/simulator-use-engine | cut -c1-16), dtuhidd $(pgrep -x dtuhidd | wc -l)"
for phone in "iPhone 17 Pro" "iPhone 17 Pro Max"; do
  tag=$(echo "$phone" | tr -d ' ')
  bash scripts/golden.sh "$phone" > ~/drive/fr/golden-$tag.log 2>&1; echo "golden $phone: exit $? $(grep -c '^PASS' ~/drive/fr/golden-$tag.log) PASS, $(grep -c '^FAIL' ~/drive/fr/golden-$tag.log) FAIL"
  if [ "$phone" = "iPhone 17 Pro" ]; then
    bash scripts/lab.sh "$phone" > ~/drive/fr/lab-$tag.log 2>&1; echo "lab $phone: exit $? $(grep -c '^PASS' ~/drive/fr/lab-$tag.log) PASS, $(grep -c '^FAIL' ~/drive/fr/lab-$tag.log) FAIL"
  fi
  pkill -f simulator-use-engine; sleep 2
  u=$(xcrun simctl list devices -j | jq -r --arg n "$phone" '.devices["com.apple.CoreSimulator.SimRuntime.iOS-27-2"][] | select(.name==$n) | .udid' | head -1)
  xcrun simctl shutdown "$u" 2>/dev/null
done
grep -h '^FAIL' ~/drive/fr/golden-*.log ~/drive/fr/lab-iPhone17Pro.log
xcrun simctl list devices | grep -E 'Booted|unavailable'
