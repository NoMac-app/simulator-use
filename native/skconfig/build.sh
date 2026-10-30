#!/bin/bash
# Builds the StoreKit configuration helper for the iOS Simulator into vendor/axe, beside the engine. Its simulated
# entitlement goes in the binary as the Simulator reads Xcode's (XML and DER sections), as Xcode does for apps.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../vendor/axe
der=$(mktemp)
trap 'rm -f "$der"' EXIT
derq query -f xml -i skconfig.entitlements -o "$der" --raw
xcrun -sdk iphonesimulator clang -O2 -arch arm64 -mios-simulator-version-min=17.0 -fobjc-arc -Wno-objc-method-access -framework Foundation main.m -o ../../vendor/axe/simulator-use-skconfig \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker skconfig.entitlements \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __ents_der -Xlinker "$der"
codesign -s - --force ../../vendor/axe/simulator-use-skconfig
