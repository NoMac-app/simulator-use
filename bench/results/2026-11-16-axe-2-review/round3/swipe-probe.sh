#!/bin/bash
# lab.sh's "swipe a row to delete" on one phone, by dtuhidd (it runs in the phone) and by Indigo (dtuhidd stopped).
#   swipe-probe.sh UDID
U=$1; cd ~/drive/src/simtap; DL="node bin/simulator-use.js"; APP=dev.simtap.edgelab
try() {
  pkill -f simulator-use-engine; xcrun simctl terminate $U $APP 2>/dev/null; xcrun simctl launch $U $APP >/dev/null; sleep 3
  $DL act --device $U 'tap Lists' 'wait "Loaded 20 results"' >/dev/null 2>&1
  out=$($DL act --device $U 'swipe left "Row 3"' 2>&1)
  echo "$1: $(grep -c 'button "Delete"' <<<"$out") Delete shown; dtuhidd $(pgrep -f /dtuhidd | head -1); $(head -1 <<<"$out" | cut -c1-60)"
  $DL look --device $U 2>/dev/null | grep -E '"Row 3"' | head -1 | sed 's/^/  /'
}
xcrun simctl boot $U 2>/dev/null; xcrun simctl bootstatus $U -b >/dev/null
try "auto (dtuhidd running: $(pgrep -f /dtuhidd | head -1))"
try "auto again"
P=$(pgrep -f /dtuhidd); [ -n "$P" ] && kill $P; sleep 2
try "auto after dtuhidd stopped"
pkill -f simulator-use-engine; true
