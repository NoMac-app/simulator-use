#!/bin/bash
# The probes after a soak, on the perf Mac: where the screen changes (watch), the first read after a launch, the
# edge-lab build, and one of each benchmark step with build B and DEBUG timings.
set -uo pipefail
source ~/drive/perf/env.sh
R=~/drive/perf/results; cd ~/drive/perf/repo
E=~/drive/perf/B/lib/node_modules/simulator-use/vendor/axe/simulator-use-engine
pkill -f simulator-use-engine; sleep 3
echo "== watch"; node bench/debug/watch.mjs $E $UDID 2>&1 | tee $R/watch-B.txt
sleep 2
echo "== launch read"; node bench/debug/launch-read.mjs $E $UDID 5 2>&1 | tee $R/launch-read-B.txt
sleep 2
echo "== edge-lab"
(cd examples/edge-lab && xcodegen generate --quiet && xcodebuild -project EdgeLab.xcodeproj -scheme EdgeLab -destination "id=$UDID" -derivedDataPath ~/drive/perf/dd-lab -quiet build CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "error|BUILD" | head -5)
xcrun simctl install $UDID ~/drive/perf/dd-lab/Build/Products/Debug-iphonesimulator/EdgeLab.app && echo installed
echo "== probe B"
BENCH_TOOLS=~/drive/perf/B SIMULATOR_USE_DEBUG=1 node bench/run.mjs --tool simulator-use --udid $UDID --probe --no-reboot --out $R/probeB 2>&1 | grep -vE "^(textfield|securefield|switch|button|text|tabs|Demo)" | tail -40
echo "== probe B debug"; tail -60 $R/probeB/simulator-use.stderr.log
echo "== done"
