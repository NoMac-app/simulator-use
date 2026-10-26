#!/bin/bash
# Builds the engine against the FBSimulatorControl frameworks in vendor/axe (from AXe's release) and idb's
# private headers (compile time only; never shipped). IDB_HEADERS: a checkout of github.com/cameroncooke/idb
# at the commit AXe pins (scripts/build.sh in AXe), PrivateHeaders folder.
set -euo pipefail
cd "$(dirname "$0")"
P=${IDB_HEADERS:?set IDB_HEADERS to idb/PrivateHeaders}
F=../../vendor/axe/Frameworks
args=()
# AXe's frameworks are binary Swift modules, which only the compiler that built them imports. A newer one falls back to
# their textual interfaces, and those do not compile (the class FBSimulatorControl shadows its own module): say so first.
want=$(sed -n 's/^\/\/ swift-compiler-version: \(Apple Swift version [0-9.]*\).*/\1/p' "$F/FBSimulatorControl.framework/Modules/FBSimulatorControl.swiftmodule/arm64-apple-macos.swiftinterface")
have=$(swiftc --version 2>&1 | sed -n 's/.*\(Apple Swift version [0-9.]*\).*/\1/p' | head -1)
if [ -n "$want" ] && [ "$want" != "$have" ]; then
  echo "The engine builds only with $want, the compiler AXe's frameworks were built with; this one is ${have:-unknown}." >&2
  echo "Point DEVELOPER_DIR at the Xcode that has it (Xcode 26.5 for Swift 6.3.2), for example DEVELOPER_DIR=/Applications/Xcode-26.5.app/Contents/Developer npm run native." >&2
  exit 1
fi
for d in AccessibilityPlatformTranslation AXRuntime CoreSimDeviceIO CoreSimulator CoreSimulatorUtilities SimulatorKit; do args+=(-I "$P/$d"); done
swiftc -O -swift-version 5 main.swift TextToHIDEvents.swift KeyCode.swift Support.swift -F "$F" -I "$P" "${args[@]}" \
  -framework FBControlCore -framework FBSimulatorControl -Xlinker -rpath -Xlinker @executable_path/Frameworks -target arm64-apple-macos14 -o simulator-use-engine
