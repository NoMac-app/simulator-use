#!/bin/bash
# The release tarball from a fresh clone: GitHub's main plus the axe-2 commits from a bundle, npm ci, npm pack (its
# prepack fetches AXe, builds the native parts with Xcode 27.2's Swift and builds dist), then the checks.
#   pack.sh BUNDLE
set -euo pipefail
B=$1
R=~/drive/rel
rm -rf "$R"; mkdir -p "$R"; cd "$R"
git clone -q https://github.com/NoMac-app/simulator-use.git su
cd su
git fetch -q "$B" axe-2
git checkout -q -B axe-2 FETCH_HEAD
echo "commit $(git log --oneline -1)"
echo "swift: $(swiftc --version 2>&1 | head -1)"
npm ci --no-audit --no-fund >/dev/null 2>&1
npm pack 2>&1 | grep -vE '^npm notice [0-9.]+[kMG]?B ' | tail -25
TGZ=$(ls simulator-use-*.tgz)
echo "tarball $TGZ $(shasum -a 256 "$TGZ" | cut -d' ' -f1) $(stat -f %z "$TGZ") bytes"
mkdir -p x && tar -xzf "$TGZ" -C x
for f in simulator-use-engine simulator-use-pbset simulator-use-skconfig; do
  h=$(shasum -a 256 "x/package/vendor/axe/$f" | cut -d' ' -f1)
  if grep -q "$h" x/package/README.md; then echo "$f $h: in the README"; else echo "$f $h: NOT IN THE README"; fi
done
grep -n '^| 0.17.0' x/package/README.md | cut -c1-60
node -e 'const p=require("./x/package/package.json"); console.log("package.json version", p.version)'
echo "modes:"; tar -tvzf "$TGZ" | grep -E 'vendor/axe/(simulator-use-|axe$)|bin/simulator-use.js|Frameworks/FBSimulatorControl.framework/Versions/A/FBSimulatorControl$'
codesign -dv x/package/vendor/axe/simulator-use-engine 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier'
x/package/vendor/axe/axe --version 2>&1 | head -1
