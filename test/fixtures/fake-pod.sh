#!/bin/bash
# A stand-in for CocoaPods' pod: records each run, then writes what pod install would (the workspace, Podfile.lock
# from the Podfile, and Pods/Manifest.lock as its copy). A Podfile naming the pod Nope fails as CocoaPods does.
echo "$PWD|$*|$CP_HOME_DIR" >> "$FAKE_POD_RUNS"
if grep -q "Nope" Podfile; then
  echo "Analyzing dependencies"
  echo "[!] Unable to find a specification for \`Nope\`" >&2
  exit 1
fi
echo "Installing Foo (1.2.3)"
mkdir -p App.xcworkspace Pods
printf 'PODS:\n  - Foo (1.2.3)\n\nPODFILE CHECKSUM: %s\n\nCOCOAPODS: 1.16.2\n' "$(shasum -a 1 Podfile | cut -d' ' -f1)" > Podfile.lock
cp Podfile.lock Pods/Manifest.lock
