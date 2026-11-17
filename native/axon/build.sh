#!/bin/bash
# Builds the accessibility helper for the iOS Simulator (both architectures) into vendor/axe, beside the engine, which
# runs it inside a phone (simctl spawn) to switch app accessibility on before its first automation session.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../vendor/axe
xcrun -sdk iphonesimulator clang -O2 -arch arm64 -arch x86_64 -mios-simulator-version-min=17.0 main.c -o ../../vendor/axe/simulator-use-axon
codesign -s - --force ../../vendor/axe/simulator-use-axon
