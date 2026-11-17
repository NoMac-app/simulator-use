#!/bin/bash
# lab.sh's three misses on one phone, looked at one by one from lab.sh's own start (a fresh EdgeLab install, a
# location set): the slider (simulator-use's set with its debug lines, then AXe's own slider command), the location
# prompt (screenshot and the phone's location log after the tap), and the first fill on the phone (screenshot after).
#   lab-probe.sh DEVICE_NAME LABEL
WANT=$1; L=$2; D=~/drive/al; O=$D/probe-$L; rm -rf $O; mkdir -p $O
cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; APP=dev.simtap.edgelab
$D/fixrt.sh >/dev/null
$DL use "$WANT" >/dev/null
U=$($DL devices | awk -v want="$WANT" -F ' · ' '$1 == "booted " want || $1 == want { print $3; exit }')
echo "$L: $WANT $U"
xcrun simctl uninstall "$U" "$APP" 2>/dev/null; xcrun simctl privacy "$U" reset all "$APP" 2>/dev/null
xcrun simctl location "$U" set 37.3349,-122.0090; echo "location set: $?"
$DL run examples/edge-lab --device "$U" 2>&1 | head -2
act() { SIMULATOR_USE_DEBUG=1 $DL act --device "$U" "$@"; }
echo "== slider"; act 'set #volume 75' 2>&1 | grep -vE '^  (heading|button|popup|segment|text|tab|switch|picker)' | cut -c1-200 | head -20
act 'set #volume 30' > /dev/null 2>&1
vendor/axe/axe slider --udid "$U" --id volume --value 75 2>&1 | tail -2 | cut -c1-200
$DL look --device "$U" 2>&1 | grep -E 'slider'
t0=$(date '+%Y-%m-%d %H:%M:%S')
echo "== location"; act 'tap Dialogs' 'tap "Ask for location"' 'wait "Allow While Using App" 20' 2>&1 | head -3 | cut -c1-160
xcrun simctl io "$U" screenshot $O/location.png >/dev/null 2>&1
xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate '(process == "locationd" OR process == "EdgeLab" OR process == "SpringBoard") AND (eventMessage CONTAINS[c] "authoriz" OR eventMessage CONTAINS[c] "prompt" OR eventMessage CONTAINS[c] "locationServicesEnabled" OR eventMessage CONTAINS[c] "dev.simtap.edgelab")' 2>&1 | cut -c1-260 | head -40 > $O/location.log
echo "location log: $(wc -l < $O/location.log) lines"; head -12 $O/location.log | cut -c24-260
act 'tap "Allow While Using App"' > /dev/null 2>&1
echo "== first fill"; act 'tap Text' 'fill #unicode Café 日本 🚀' 'wait "Typed: Café"' 2>&1 | grep -E 'simulator-use:|failed|Step|unicode|keyboard|done' | cut -c1-200 | head -20
xcrun simctl io "$U" screenshot $O/fill.png >/dev/null 2>&1
echo "== second fill"; act 'fill #unicode Café 日本 🚀' 'wait "Typed: Café"' 2>&1 | grep -E 'failed|Step|unicode|done' | cut -c1-200 | head -6
pkill -f simulator-use-engine; true
