#!/bin/bash
# The Mac's and the phone's keyboard settings, and the edit menu after a tap on the focused field (read at its point).
#   paste-probe5.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
echo "Mac: ConnectHardwareKeyboard=$(defaults read com.apple.iphonesimulator ConnectHardwareKeyboard 2>&1 | head -1)"
defaults read com.apple.iphonesimulator 2>/dev/null | grep -iE 'keyboard|pasteboard|clipboard' | head -8
echo "phone keyboard prefs:"; xcrun simctl spawn $U defaults read com.apple.keyboard.preferences 2>/dev/null | head -12
xcrun simctl spawn $U defaults read com.apple.Preferences 2>/dev/null | grep -iE 'keyboard|hardware' | head -5
grep -rl "HardwareKeyboard\|ConnectHardwareKeyboard" ~/NOMAC.md /etc/nomac* ~/.nomac 2>/dev/null | head -3
pos=$($DL look --device "$U" 2>/dev/null | grep '#unicode' | grep -oE '@[0-9]+,[0-9]+' | tr -d @); X=${pos%,*}; Y=${pos#*,}
printf 'Pasted5' | xcrun simctl spawn $U $PWD/vendor/axe/simulator-use-pbset - >/dev/null
node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.8},{\"tap\":[$X,$Y]}]"; sleep 1.2
xcrun simctl io "$U" screenshot $D/probe-promax/menu.png >/dev/null 2>&1; sips -Z 500 $D/probe-promax/menu.png --out $D/probe-promax/menu-s.png >/dev/null
$DL look --device "$U" 2>/dev/null | grep -iE 'paste|autofill|menu|#unicode' | head -5
$DL look --device "$U" --json 2>/dev/null | grep -oiE '"[^"]*(paste|autofill)[^"]*"' | head -5
pkill -f simulator-use-engine; true
