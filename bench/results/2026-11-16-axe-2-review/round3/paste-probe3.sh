#!/bin/bash
# Is it the clipboard's source? Cmd-V after simctl pbcopy (written by CoreSimulatorBridge) and after the phone's own
# helper (simulator-use-pbset, inside the phone); then the field's own Paste button (edit menu).   paste-probe3.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
field() { $DL look --device "$U" 2>/dev/null | grep -E '#unicode' | tr '\n' ' '; echo; }
pos=$($DL look --device "$U" 2>/dev/null | grep '#unicode' | grep -oE '@[0-9]+,[0-9]+' | tr -d @); X=${pos%,*}; Y=${pos#*,}
clear='{"combo":{"mods":[227],"key":4}},{"key":42}'
echo "1. simctl pbcopy, Cmd-V"; printf 'FromMac1' | xcrun simctl pbcopy $U; echo "  pbpaste: $(xcrun simctl pbpaste $U)"
node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},$clear,{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "2. helper inside the phone, Cmd-V"; printf 'FromPhone2' | xcrun simctl spawn $U $PWD/vendor/axe/simulator-use-pbset -; echo "  pbpaste: $(xcrun simctl pbpaste $U)"
node /tmp/steps.mjs $BE $U "[$clear,{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "3. helper, Cmd-V again 2 s later"; sleep 2; node /tmp/steps.mjs $BE $U "[$clear,{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "4. the edit menu's Paste"; node /tmp/steps.mjs $BE $U "[$clear,{\"tap\":[$X,$Y]}]"; sleep 1.5
$DL look --device "$U" 2>/dev/null | grep -iE 'paste|autofill|menu' | head -4
$DL act --device "$U" 'tap Paste' 2>&1 | head -1 | cut -c1-120; sleep 1; field
xcrun simctl io "$U" screenshot $D/probe-promax/paste3.png >/dev/null 2>&1; sips -Z 700 $D/probe-promax/paste3.png --out $D/probe-promax/paste3-s.png >/dev/null
xcrun simctl spawn $U log show --last 2m --style compact --predicate 'eventMessage CONTAINS[c] "paste"' 2>/dev/null | grep -v getpwuid | cut -c24-230 | tail -12
pkill -f simulator-use-engine; true
