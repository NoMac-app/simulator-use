#!/bin/bash
# The edge-case lab: builds examples/edge-lab and checks the awkward screens real apps have: segments, a stepper,
# a slider, a menu, an alert, a sheet, a full-screen cover, iOS's permission prompts, text in any language,
# autocorrect, swipe-to-delete, a context menu, delayed content, a toast, a web view, UIKit, a deep link.
# Exits non-zero on any miss. Usage: scripts/lab.sh [simulator name]   (default: iPhone 17 Pro)
set -euo pipefail
cd "$(dirname "$0")/.."
DL="node bin/simulator-use.js"
WANT="${1:-iPhone 17 Pro}"
APP=dev.simtap.edgelab

$DL use "$WANT"
U=$($DL devices | awk -v want="$WANT" -F ' · ' '$1 == "booted " want || $1 == want { print $3; exit }')
[ -n "$U" ] || { echo "No Simulator named $WANT"; exit 1; }
# A fresh install: iOS asks for location and notifications once per install (an answer outlives simctl privacy
# reset), and asks for location only on a phone that has one (a Mac without Location Services gives it none).
xcrun simctl uninstall "$U" "$APP" 2>/dev/null || true
xcrun simctl privacy "$U" reset all "$APP" 2>/dev/null || true
xcrun simctl location "$U" set 37.3349,-122.0090 2>/dev/null || true

fail=0
check() { # name, expected pattern, command...
  local name="$1" pattern="$2"; shift 2
  local start=$(date +%s)
  if out=$("$@" 2>&1) && grep -qE "$pattern" <<<"$out"; then echo "PASS $name ($(( $(date +%s) - start )) s)"
  else echo "FAIL $name"; echo "$out" | sed 's/^/  /'; fail=1; fi
}
act() { $DL act --device "$U" "$@"; }

# --permissions ask: the lab checks iOS's own prompts, which run's default (grant every permission simctl can, so no
# prompt stops an app under test) answers before they show: with it, "Ask for location" asked nothing (November 17,
# 2026: locationd had EdgeLab authorized when in use, set at install).
check "build, install and launch" 'EdgeLab · Controls' $DL run examples/edge-lab --device "$U" --permissions ask
# The engine reads without opening an automation session per read (scripts/engine-check.mjs).
check "the engine reads on its fast path" '^fast path' node scripts/engine-check.mjs "$U"
check "segments are not tabs" '^segment "M" selected' $DL look --device "$U"
check "stepper buttons" 'Count: 3' act 'tap #count-Increment'
check "set a slider" '#volume "Volume" ="0\.75"|#volume' act 'set #volume 75'
check "menu pick" 'Flavor, Chocolate' act 'tap #flavor' 'tap Chocolate'
check "alert in front, alone" 'An alert is in front' act 'tap Dialogs' 'tap "Show alert"'
check "answer the alert" 'Result: cancelled' act 'tap Cancel'
check "sheet in front, its Done reachable" '^button "Done"' act 'tap "Show sheet"'
check "close the sheet" 'Show alert' act 'tap Done'
check "full-screen cover" '#closeCover' act 'tap "Show full screen"'
check "close the cover" 'Show alert' act 'tap #closeCover'
# The prompt can come several seconds after the tap (9 s on a Session Mac): until it is in front, later steps meet it.
check "iOS permission prompt, named after the app" 'EdgeLab · system alert' act 'tap "Ask for location"' 'wait "Allow While Using App" 20'
check "allow it" 'Dialogs' act 'tap "Allow While Using App"'
# iOS asks for notifications once per install (simctl can't reset it): answer the prompt if it is still in front.
# Only a screen read names one ("· system alert"): open_url answers "Open in" itself and says so, and a tap on its
# Open button afterwards finds none (every first run on a phone failed so, with any engine, until November 16, 2026).
allow_if_asked() { local out; out=$("$@" 2>&1); if grep -q "· system alert" <<<"$out"; then act "tap ${ANSWER}"; else echo "$out"; fi; }
ANSWER=Allow check "notifications, prompt waited for and allowed" 'notifications true' allow_if_asked act 'tap "Ask for notifications"' 'wait "notifications true"'
check "text in any language" 'Typed: Café 日本 🚀' act 'tap Text' 'fill #unicode Café 日本 🚀' 'wait "Typed: Café"'
check "autocorrect undone by paste" 'pasted instead|O.Brien' act "fill #unicode O'Brien --id x"
check "delayed content" 'Loaded 20 results' act 'tap Lists' 'wait "Loaded 20 results"'
check "toast comes and goes" 'steps done' act 'tap "Show toast"' 'wait Saved' 'gone Saved'
check "swipe a row to delete" 'button "Delete"' act 'swipe left "Row 3"'
check "delete it" 'gone: text "Row 3"|Row 4' act 'tap Delete'
check "long press menu" 'Pin Row 5' act 'hold "Row 5"'
check "pin from the menu" 'steps? done' act 'tap "Pin Row 5"'
# This web view is hosted by SwiftUI, where iOS 27 gives no reader the page (point reads and XCTest's own requests
# fail): it is called unreadable, with the way to work it. iOS 26 gives the page, and it is read (its field, button and
# text; November 16, 2026, iOS 26.5). A WKWebView in UIKit (Capacitor, React Native, most apps) is read in full by the
# engine (native/engine/bench/host/webtest).
check "web view called unreadable, or read" '^unreadable @|^button "Web button"' act 'tap More' 'tap "Web page"'
check "UIKit table, real title" 'EdgeLab · UIKit table' act back 'tap "UIKit table"'
# iOS asks "Open in EdgeLab?" the first time only.
ANSWER=Open check "deep link opened" 'Opened|EdgeLab' allow_if_asked $DL app open_url "edgelab://item/7" --device "$U"
# The label is under the field filled above: on a phone without a hardware keyboard the keyboard covers it.
check "deep link arrives" 'Deep link: edgelab://item/7' act 'tap Text' 'key return' 'wait "Deep link: edgelab"'
exit $fail
