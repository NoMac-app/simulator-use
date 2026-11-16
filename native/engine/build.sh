#!/bin/bash
# Builds the engine against the FBSimulatorControl frameworks in vendor/axe (from AXe's release) and idb's
# private headers (compile time only; never shipped). IDB_HEADERS: the PrivateHeaders folder of AXe's repository
# (Packages/IDBKit/PrivateHeaders) at the commit of the pinned release; scripts/build-native.mjs fetches it.
set -euo pipefail
cd "$(dirname "$0")"
P=${IDB_HEADERS:?set IDB_HEADERS to AXe/Packages/IDBKit/PrivateHeaders}
F=../../vendor/axe/Frameworks
args=()
# AXe's frameworks are binary Swift modules, which only the compiler that built them imports, and the build is
# reproducible only with that compiler: say so first. The frameworks name it in their interface's first lines.
interface="$F/FBSimulatorControl.framework/Modules/FBSimulatorControl.swiftmodule/arm64-apple-macos.swiftinterface"
want=$(sed -n 's/^\/\/ swift-compiler-version: \(Apple Swift version [0-9.]*\).*(\(swiftlang-[0-9.]*\).*/\1 (\2)/p' "$interface")
have=$(swiftc --version 2>&1 | sed -n 's/.*\(Apple Swift version [0-9.]*\).*(\(swiftlang-[0-9.]*\).*/\1 (\2)/p' | head -1)
if [ -z "$want" ]; then
  echo "AXe's frameworks in vendor/axe do not name the Swift that built them ($interface): run scripts/fetch-axe.mjs again." >&2
  exit 1
fi
if [ "$want" != "$have" ]; then
  echo "The engine builds only with $want, the compiler AXe's frameworks were built with; this one is ${have:-unknown}." >&2
  echo "For AXe 2.0.4 that is Xcode 27.2. Point DEVELOPER_DIR at it, for example DEVELOPER_DIR=/Applications/Xcode-27.2.app/Contents/Developer npm run native." >&2
  exit 1
fi
for d in AccessibilityPlatformTranslation AXRuntime CoreSimDeviceIO CoreSimulator CoreSimulatorUtilities SimulatorKit; do args+=(-I "$P/$d"); done
swiftc -O -swift-version 5 main.swift Frames.swift Settle.swift Input.swift TextToHIDEvents.swift KeyCode.swift Support.swift -F "$F" -I "$P" "${args[@]}" \
  -framework FBControlCore -framework FBSimulatorControl -Xlinker -rpath -Xlinker @executable_path/Frameworks -target arm64-apple-macos14 -o simulator-use-engine
