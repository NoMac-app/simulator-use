#!/bin/bash
# Cmd-A and Cmd-V by dtuhidd, clean; then with Device Hub quit and dtuhidd gone (Indigo), simulator-use's fill.
#   paste-probe4.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
field() { $DL look --device "$U" 2>/dev/null | grep -E '#unicode' | tr '\n' ' '; echo; }
pos=$($DL look --device "$U" 2>/dev/null | grep '#unicode' | grep -oE '@[0-9]+,[0-9]+' | tr -d @); X=${pos%,*}; Y=${pos#*,}
echo "UI apps: $(ps -axo comm | grep -iE 'hub|simulator\.app|Simulator$' | sort -u | tr '\n' ' ')"
echo "dtuhidd: $(pgrep -f '/dtuhidd' | tr '\n' ' ')"
echo "1. dtuhid: type abcdef"; node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},{\"type\":\"abcdef\"}]"; sleep 1; field
echo "2. dtuhid: Cmd-A, delete"; node /tmp/steps.mjs $BE $U '[{"combo":{"mods":[227],"key":4}},{"key":42}]'; sleep 1; field
echo "3. dtuhid: helper sets Pasted3, Cmd-V"; printf 'Pasted3' | xcrun simctl spawn $U $PWD/vendor/axe/simulator-use-pbset - >/dev/null
node /tmp/steps.mjs $BE $U '[{"combo":{"mods":[227],"key":25}}]'; sleep 1; field
for app in "Device Hub" DeviceHub Simulator; do osascript -e "quit app \"$app\"" 2>/dev/null; done; sleep 3
pkill -x DeviceHub 2>/dev/null; pkill -f 'Device Hub.app' 2>/dev/null; sleep 2
echo "after quitting: UI apps: $(ps -axo comm | grep -iE 'hub|simulator\.app|Simulator$' | sort -u | tr '\n' ' ') dtuhidd: $(pgrep -f '/dtuhidd' | tr '\n' ' ')"
P=$(pgrep -f '/dtuhidd'); [ -n "$P" ] && { kill $P; sleep 2; echo "dtuhidd killed; now: $(pgrep -f '/dtuhidd' | tr '\n' ' ')"; }
echo "4. indigo: Cmd-A, delete, Cmd-V"; SIMULATOR_USE_ENGINE_HID=indigo node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},{\"combo\":{\"mods\":[227],\"key\":4}},{\"key\":42},{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "5. simulator-use fill (auto)"; $DL act --device "$U" 'fill #unicode Café 日本 🚀' 2>&1 | head -1 | cut -c1-120; field
echo "dtuhidd at the end: $(pgrep -f '/dtuhidd' | tr '\n' ' ')"
pkill -f simulator-use-engine; true
