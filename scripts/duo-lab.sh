#!/bin/bash
# The iPhone Duo lab (iphone-duo-plan.md, Phase 4 L2): each posture and each of the six moves between them, repeated,
# on a real Duo Simulator, with the app in examples/duo-lab proving where every tap, key and swipe landed. Needs Xcode
# 27.2 (or later) with the iPhone Duo's runtime, XcodeGen, and this checkout built (npm run build, npm run native).
# Exits non-zero on any miss; the results are in $OUT/duo-lab.json.
#   scripts/duo-lab.sh [--rounds N] [--udid UDID] [--out DIR] [--keep]
# Without --udid a Duo is made on the Duo's runtime and deleted at the end (--keep leaves it).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/duo-lab.mjs "$@"
