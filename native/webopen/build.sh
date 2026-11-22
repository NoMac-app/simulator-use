#!/bin/bash
# Builds the library that lets an app's web views be inspected (main.m), for the iOS Simulator (both architectures),
# into vendor/axe beside the engine. simulator-use loads it into the apps it launches.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../vendor/axe
xcrun -sdk iphonesimulator clang -O2 -dynamiclib -arch arm64 -arch x86_64 -mios-simulator-version-min=17.0 -fobjc-arc -framework Foundation -framework WebKit \
  -install_name @rpath/simulator-use-webopen.dylib main.m -o ../../vendor/axe/simulator-use-webopen.dylib
codesign -s - --force ../../vendor/axe/simulator-use-webopen.dylib
