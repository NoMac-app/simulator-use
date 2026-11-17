#!/bin/bash
# Why EdgeLab's location prompt does not show: locationd's record of the app and its log, after lab.sh's start
# (uninstall, privacy reset, location set, install) and after an install without the privacy reset.
#   loc-probe.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap; DL="node bin/simulator-use.js"; APP=dev.simtap.edgelab
C=~/Library/Developer/CoreSimulator/Devices/$U/data/Library/Caches/locationd/clients.plist
record() { plutil -convert json -o - "$C" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print('  ', k[:60], {x: v for x, v in d[k].items() if x in ('Authorization','SupportedAuthorizationMask','Registered','Executable','LocationTimeStopped','IncidentalUseMode','Whitelisted')}) for k in d if 'edgelab' in k.lower()] or print('   no record')"; }
try() {
  echo "-- $1"; record
  t0=$(date '+%Y-%m-%d %H:%M:%S')
  $DL act --device "$U" 'tap Dialogs' 'tap "Ask for location"' 'wait "Allow While Using App" 8' 2>&1 | head -1 | cut -c1-100
  record
  xcrun simctl spawn "$U" log show --start "$t0" --style compact --predicate 'process == "locationd" OR (process == "EdgeLab" AND (eventMessage CONTAINS[c] "location" OR eventMessage CONTAINS[c] "authoriz"))' 2>/dev/null | grep -iE 'edgelab|authoriz|prompt|enabled' | grep -v getpwuid | cut -c24-230 | head -8
  $DL act --device "$U" 'tap "Allow While Using App"' >/dev/null 2>&1
}
echo "location services: $(xcrun simctl spawn $U defaults read /var/mobile/Library/Preferences/com.apple.locationd LocationServicesEnabled 2>&1 | tail -1)"
xcrun simctl uninstall "$U" "$APP" 2>/dev/null; xcrun simctl privacy "$U" reset all "$APP" 2>/dev/null; xcrun simctl location "$U" set 37.3349,-122.0090
$DL run examples/edge-lab --device "$U" >/dev/null 2>&1
try "lab.sh's start (uninstall, privacy reset, location, install)"
xcrun simctl uninstall "$U" "$APP"; $DL run examples/edge-lab --device "$U" >/dev/null 2>&1
try "uninstall and install only"
pkill -f simulator-use-engine; true
