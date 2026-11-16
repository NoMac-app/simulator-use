#!/bin/bash
# The packed 0.17.0 on this laptop's Xcode 26.5 and iOS 26.5: golden.sh and lab.sh from the repository, run against the
# tarball's own bin, dist and vendor/axe, on the iOS 26.5 iPhone 17 Pro already booted here (the one Simulator at a
# time this 8 GB laptop takes); the test apps are removed after.
#   laptop-test.sh TARBALL REPO
set -uo pipefail
TGZ=$1; REPO=$2
S=/private/tmp/claude-501/-Users-gergomiklos-pubkit/56233eb1-786a-4c38-bafe-f893dbabefce/scratchpad
T=$S/t017; rm -rf "$T"; mkdir -p "$T"
tar -xzf "$TGZ" -C "$T"
P=$T/package
cp -R "$REPO/scripts" "$REPO/examples" "$P/"
echo "xcode: $(xcodebuild -version | tr '\n' ' ')"
echo "engine: $(shasum -a 256 "$P/vendor/axe/simulator-use-engine" | cut -c1-16)"
U=B618F794-4904-462A-B413-DCB46824A2DE
xcrun simctl list devices | grep "$U"
export SIMULATOR_USE_STATE_DIR=$S/su-state SIMULATOR_USE_CACHE_DIR=$S/su-cache
cd "$P"
bash scripts/golden.sh "iPhone 17 Pro" > "$S/laptop-golden.log" 2>&1; echo "golden exit $?: $(grep -c '^PASS' $S/laptop-golden.log) PASS, $(grep -c '^FAIL' $S/laptop-golden.log) FAIL"
bash scripts/lab.sh "iPhone 17 Pro" > "$S/laptop-lab.log" 2>&1; echo "lab exit $?: $(grep -c '^PASS' $S/laptop-lab.log) PASS, $(grep -c '^FAIL' $S/laptop-lab.log) FAIL"
pkill -f "$P/vendor/axe/simulator-use-engine"; sleep 2
for app in dev.simtap.demo dev.simtap.edgelab; do xcrun simctl uninstall "$U" "$app"; done
rm -rf "$S/su-cache" "$S/su-state" "$T"
echo "done; test apps removed"
