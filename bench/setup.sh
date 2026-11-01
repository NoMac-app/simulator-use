#!/bin/bash
# Prepares a Mac for the benchmark: installs every tool at its pinned version in $BENCH_TOOLS (nothing global
# but Homebrew's AXe and Java), builds the demo app, and creates and boots one iPhone 17 Pro Simulator on the newest
# iOS runtime. Prints the lines to export for run.mjs. Run from the repository: bash bench/setup.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export BENCH_TOOLS=${BENCH_TOOLS:-$HOME/bench-tools}
mkdir -p "$BENCH_TOOLS"

# The versions tested (bench/results/<date>/*.json record what actually ran).
SIMULATOR_USE=0.15.0
MOBILEBUILDMCP=2.7.1
MOBILE_MCP=1.0.15
AGENT_DEVICE=0.21.35
ARGENT=0.31.0
MAESTRO=2.12.0

echo "== npm packages into $BENCH_TOOLS"
npm install -g --no-fund --no-audit --prefix "$BENCH_TOOLS" \
  "simulator-use@$SIMULATOR_USE" "mobilebuildmcp@$MOBILEBUILDMCP" "@mobilenext/mobile-mcp@$MOBILE_MCP" \
  "agent-device@$AGENT_DEVICE" "@swmansion/argent@$ARGENT"

echo "== AXe (Homebrew, as its README installs it)"
command -v axe >/dev/null || brew install cameroncooke/axe/axe
axe --version

echo "== Java 17 and Maestro $MAESTRO (its installer, MAESTRO_VERSION pinned)"
if ! /usr/libexec/java_home -v 17+ >/dev/null 2>&1; then brew install openjdk@17; fi
JAVA_HOME=$(/usr/libexec/java_home -v 17+ 2>/dev/null || echo "$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home")
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
java -version 2>&1 | head -1
if [ ! -x "$BENCH_TOOLS/maestro/bin/maestro" ]; then
  curl -fsSL https://get.maestro.mobile.dev -o "$BENCH_TOOLS/maestro-install.sh"
  MAESTRO_VERSION=$MAESTRO MAESTRO_DIR="$BENCH_TOOLS/maestro" bash "$BENCH_TOOLS/maestro-install.sh" >/dev/null
fi
"$BENCH_TOOLS/maestro/bin/maestro" --version

echo "== Xcode's MCP server, headless (Xcode 27), every agent allowed (an unattended Mac)"
sudo xcrun mcp-server enable --unsafe-always-allow-all-agents || echo "xcrun mcp-server enable failed"
xcrun mcp-server status || true

echo "== the iPhone 17 Pro Simulator on the newest iOS runtime"
RUNTIME=$(xcrun simctl list runtimes -j | /usr/bin/python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["platform"]=="iOS" and x["isAvailable"]]; r.sort(key=lambda x: [int(p) for p in x["version"].split(".")]); print(r[-1]["identifier"])')
UDID=$(xcrun simctl list devices -j | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin)['devices'].get('$RUNTIME',[]); print(next((x['udid'] for x in d if x['name']=='Bench iPhone 17 Pro'),''))")
[ -n "$UDID" ] || UDID=$(xcrun simctl create "Bench iPhone 17 Pro" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$RUNTIME")
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

echo "== the demo app (examples/swiftui-demo)"
cd "$REPO/examples/swiftui-demo"
xcodegen generate --quiet
xcodebuild -project Demo.xcodeproj -scheme Demo -destination "id=$UDID" -derivedDataPath "$BENCH_TOOLS/dd" -quiet build CODE_SIGNING_ALLOWED=NO
xcrun simctl install "$UDID" "$BENCH_TOOLS/dd/Build/Products/Debug-iphonesimulator/Demo.app"
xcrun simctl launch "$UDID" dev.simtap.demo

cat > "$BENCH_TOOLS/env.sh" <<ENV
export BENCH_TOOLS="$BENCH_TOOLS"
export UDID="$UDID"
export JAVA_HOME="$JAVA_HOME"
export MAESTRO_BIN="$BENCH_TOOLS/maestro/bin/maestro"
export PATH="$BENCH_TOOLS/bin:$JAVA_HOME/bin:$BENCH_TOOLS/maestro/bin:\$PATH"
ENV
echo "== ready: source $BENCH_TOOLS/env.sh"
cat "$BENCH_TOOLS/env.sh"
