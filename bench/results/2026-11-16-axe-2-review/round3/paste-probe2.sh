#!/bin/bash
# Cmd-key combos by dtuhidd (Device Hub showing the phone) and by Indigo (Device Hub quit), and simulator-use's fill
# both ways.   paste-probe2.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
field() { $DL look --device "$U" 2>/dev/null | grep -E '#unicode' | tr '\n' ' '; echo; }
pos=$($DL look --device "$U" 2>/dev/null | grep '#unicode' | grep -oE '@[0-9]+,[0-9]+' | tr -d @); X=${pos%,*}; Y=${pos#*,}
echo "dtuhidd: $(pgrep -f '/dtuhidd' | head -1), Device Hub: $(pgrep -fl 'DeviceHub|Simulator.app' | head -1 | cut -c1-80)"
echo "1. dtuhid: tap, type abc, Cmd-A, delete"; node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},{\"type\":\"abc\"},{\"combo\":{\"mods\":[227],\"key\":4}},{\"key\":42}]"; sleep 1; field
echo "2. dtuhid: shift-a (a modifier that types)"; node /tmp/steps.mjs $BE $U '[{"combo":{"mods":[225],"key":4}}]'; sleep 1; field
echo "3. simulator-use fill with Device Hub"; $DL act --device "$U" 'fill #unicode Café 日本 🚀' 2>&1 | head -1 | cut -c1-120
osascript -e 'quit app "DeviceHub"' 2>/dev/null; osascript -e 'quit app "Simulator"' 2>/dev/null; sleep 4
echo "dtuhidd after quitting: $(pgrep -f '/dtuhidd' | head -1)"
echo "4. indigo: tap, type abc, Cmd-A, delete"; node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},{\"type\":\"abc\"},{\"combo\":{\"mods\":[227],\"key\":4}},{\"key\":42}]"; sleep 1; field
echo "5. simulator-use fill without Device Hub"; $DL act --device "$U" 'fill #unicode Café 日本 🚀' 2>&1 | head -1 | cut -c1-120; field
pkill -f simulator-use-engine; true
