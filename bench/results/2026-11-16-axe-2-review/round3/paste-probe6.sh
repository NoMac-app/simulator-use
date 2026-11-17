#!/bin/bash
# The phone's own log around one Cmd-V into the focused #unicode field: EdgeLab, pasted, backboardd, InputUI.
#   paste-probe6.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
printf 'Pasted6' | xcrun simctl spawn $U $PWD/vendor/axe/simulator-use-pbset - >/dev/null
t0=$(date '+%Y-%m-%d %H:%M:%S'); sleep 1
node /tmp/steps.mjs $BE $U '[{"combo":{"mods":[227],"key":25}}]'; sleep 2
xcrun simctl spawn $U log show --start "$t0" --style compact --predicate '(process == "EdgeLab" OR process == "pasted" OR process == "backboardd" OR process == "InputUI" OR process == "kbd") AND NOT (eventMessage CONTAINS "runningboard")' 2>/dev/null | grep -v getpwuid | cut -c24-250 | grep -viE 'didUpdate|frame|layout' | head -40
pkill -f simulator-use-engine; true
