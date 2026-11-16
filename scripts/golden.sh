#!/bin/bash
# The golden tasks on the sample app, with simulator-use doing everything: boot an iPhone; build, install and launch
# in one call; sign in, toggle, open an item, go back, scroll; read the app's logs; find a crash; get a build
# error and a failing test back as file:line; record a video; and check a wrong password fails loudly.
# Exits non-zero on any miss.
# Usage: scripts/golden.sh [simulator name]   (default: iPhone 17 Pro, on the newest runtime)
set -euo pipefail
cd "$(dirname "$0")/.."
DL="node bin/simulator-use.js"
WANT="${1:-iPhone 17 Pro}"
OUT="$(mktemp -d)"

$DL use "$WANT"
U=$($DL devices | awk -v want="$WANT" -F ' · ' '$1 == "booted " want || $1 == want { print $3; exit }')
[ -n "$U" ] || { echo "No Simulator named $WANT"; exit 1; }

fail=0
check() { # name, expected pattern, command...
  local name="$1" pattern="$2"; shift 2
  local start=$(date +%s)
  if out=$("$@" 2>&1) && grep -qE "$pattern" <<<"$out"; then echo "PASS $name ($(( $(date +%s) - start )) s)"
  else echo "FAIL $name"; echo "$out" | sed 's/^/  /'; fail=1; fi
}
expect_failure() { # name, expected pattern, command...: the command must fail, and say why
  local name="$1" pattern="$2"; shift 2
  if out=$("$@" 2>&1); then echo "FAIL $name (succeeded)"; echo "$out" | sed 's/^/  /'; fail=1
  elif grep -qE "$pattern" <<<"$out"; then echo "PASS $name"
  else echo "FAIL $name (wrong message)"; echo "$out" | sed 's/^/  /'; fail=1; fi
}

check "build, install and launch in one call" "#signIn @|screen can.t be read yet" $DL run examples/swiftui-demo --device "$U"
# The app this run built: other projects' DerivedData may hold a Demo.app too, so pick it by bundle id.
APP=$(for a in $(find "${SIMULATOR_USE_CACHE_DIR:-${TMPDIR:-/tmp}/simulator-use}/DerivedData" -maxdepth 6 -path '*Debug-iphonesimulator/*.app' -type d); do if [ "$(plutil -extract CFBundleIdentifier raw "$a/Info.plist" 2>/dev/null)" = dev.simtap.demo ]; then echo "$a"; break; fi; done)
check "install a built app" 'Installed Demo \(dev\.simtap\.demo\)' $DL app install "$APP" --device "$U"
check "launch answers with the first screen" '#signIn @' $DL app launch dev.simtap.demo --device "$U"
check "sign in" 'Welcome, gary@example\.com' $DL act --device "$U" "fill #email gary@example.com" "fill #password secret1" "tap #signIn" 'wait "Welcome"'
check "toggle a switch" '#remember "Remember me" on' $DL act --device "$U" 'tap #remember'
check "open an item" 'Details for Item 3' $DL act --device "$U" 'tap Items' 'tap "Item 3"'
# The list's length in pages is iOS's own count (its scroll bar's), so it depends on the phone: 4 on an iPhone 17 Pro, 3
# on a Pro Max, and on any other phone the count the list shows back at its top. The scroll must leave it at a percent
# of that many pages, not "at top".
top=$($DL act --device "$U" back 2>&1 || true)
case "$WANT" in
  "iPhone 17 Pro") PAGES=4 ;;
  "iPhone 17 Pro Max") PAGES=3 ;;
  *) PAGES=$(grep -oE 'scroll: [0-9]+ pages, at top' <<<"$top" | grep -oE '[0-9]+' | head -1 || true) ;;
esac
check "back and scroll" "scroll: ${PAGES:-no count at the top,} pages, at [0-9]+%" $DL act --device "$U" 'scroll down'
logs=$($DL logs --device "$U" 2>&1)
check "the app's print output" 'Sign In tapped, ok: true' echo "$logs"
check "the app's own system log line" 'info login: signed in' echo "$logs"
check "only the app's lines" '^ONLY$' sh -c "grep -qE 'UIKit|CoreHaptics|RunningBoard' <<<\"\$0\" && echo NOISE || echo ONLY" "$logs"
check "find a crash" 'App\.swift:[0-9]+: Fatal error' sh -c "$DL act --device $U 'tap Items' 'tap #crash' >/dev/null; $DL logs --crashes --device $U"
check "relaunch after the crash" '#signIn @' $DL app launch dev.simtap.demo --device "$U"
BROKEN="$OUT/broken"; mkdir -p "$BROKEN"; cp -R examples/swiftui-demo/project.yml examples/swiftui-demo/Sources examples/swiftui-demo/Tests "$BROKEN/"
sed -i '' 's/    email.contains("@")/    emial.contains("@")/' "$BROKEN/Sources/App.swift"
expect_failure "a build error comes back as file:line" 'Sources/App\.swift:[0-9]+:[0-9]+: error: cannot find .emial. in scope' $DL run "$BROKEN" --device "$U"
check "the tests pass" '^Tests passed: 3 passed, 0 failed' $DL test examples/swiftui-demo --device "$U"
FAILING="$OUT/failing"; mkdir -p "$FAILING"; cp -R examples/swiftui-demo/project.yml examples/swiftui-demo/Sources examples/swiftui-demo/Tests "$FAILING/"
sed -i '' 's/password: "abc"), "Invalid/password: "abcd"), "Invalid/' "$FAILING/Tests/SignInTests.swift"
expect_failure "a failing test comes back as file:line" 'DemoTests/SignInTests/testRejectsAShortPassword\(\): Tests/SignInTests\.swift:12: XCTAssertEqual failed' $DL test "$FAILING" --device "$U"
expect_failure "0 tests is not a pass" '^0 tests ran' $DL test examples/swiftui-demo --only DemoTests/Nothing --device "$U"
# Running tests leaves the Simulator on the home screen: the app comes back by launch.
check "launch again after the tests" '#signIn @' $DL app launch dev.simtap.demo --device "$U"
check "record a video" 'Recorded [0-9]+ s' sh -c "$DL record stop --device $U >/dev/null 2>&1; $DL record start --device $U >/dev/null && $DL act --device $U 'tap Items' 'tap \"Item 2\"' back >/dev/null && $DL record stop --device $U"
expect_failure "a wrong password fails loudly" 'did not appear' $DL act --device "$U" 'tap Login' "fill #email bad" "tap #signIn" 'wait "Welcome" 2'
rm -rf "$OUT"
exit $fail
