#!/bin/bash
# Session Macs lose their iOS runtime about 10 minutes after the first Simulator use (a fix is pending rollout):
# "Malformed bundle" / "cannot determine the runtime bundle". Restarting CoreSimulatorService and simdiskimaged
# brings it back. Prints what it did, and the runtime line.
if xcrun simctl list devices available 2>&1 | grep -q 'Malformed bundle\|runtime profile not found' || ! xcrun simctl list runtimes 2>/dev/null | grep -q 'iOS 27.2'; then
  echo "fixrt: iOS runtime lost at $(date -u +%H:%M:%S), restarting CoreSimulatorService and simdiskimaged" | tee -a ~/drive/al/fixrt.log
  pkill -f simulator-use-engine
  sudo killall -9 simdiskimaged 2>/dev/null
  killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null
  sleep 5
fi
xcrun simctl list runtimes 2>&1 | grep -E 'iOS|Malformed' | head -2
