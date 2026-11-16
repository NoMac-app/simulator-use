# The engine on AXe 2.0.4 (November 16, 2026)

Phase 1a and 1b of the iPhone Duo plan: simulator-use's engine moved from AXe 1.8.0's frameworks to AXe 2.0.4's, with
no Duo code, and checked for regressions. Everything below ran on one NoMac Session Mac (M5 Pro virtual Mac, 6 cores,
8 GB, macOS 26.6.2, Xcode 27.2 27B52, iOS 27.2 24B8117) from 16:12 to 18:32 UTC, on branch `axe-2`.

## What changed

- `scripts/fetch-axe.mjs`: AXe 2.0.4, sha256 `3178ec66d9ff46455fec737debad719c41cab16edb1435b2c721e07760a208c3`.
- `scripts/build-native.mjs`: idb's private headers now come from AXe's own repository (`Packages/IDBKit/PrivateHeaders`)
  at `3e4100f6805b78a2b457935afa086e95d1c8cf7d` (tag v2.0.4), one shallow fetch of that commit; `IDB_REF` is gone.
- `native/engine/build.sh`: the compiler must be the frameworks' own, now matched on the exact swiftlang build
  (Swift 6.4.2, swiftlang-6.4.2.1.9: Xcode 27.2), and the message names Xcode 27.2.
- `native/engine/main.swift`: the API is source-compatible (the build needed only `@preconcurrency` on the imports).
  The request loop reads stdin on a thread of its own, so the main actor never blocks between requests (before, it
  sat in `readLine()`). Reads go through one of two paths, both without a session per read: `session` (the kept
  automation session, as before; the default) and `axe` (AXe 2.0's: reads with `bootstrap: false`, a short-lived
  session only to reload an app that reads empty). The ready line names the path (`reads`) and the HID transport
  (`hid`); answers count `bootstraps` and `sessions`. `TextToHIDEvents.swift` and `KeyCode.swift` are identical in
  AXe 1.8.0 and 2.0.4.
- `scripts/engine-check.mjs` (new, run by `lab.sh`): fails when the engine reads on the slow per-call path.
- The CLI fallbacks (`src/engine/axe.ts`, `src/tools/ui-act.ts`, the slider): every subcommand and flag they use
  (`describe-ui [--point]`, `screenshot --output`, `batch --ax-cache none --type-submission composite --step`, its
  `tap -x -y [--tap-style physical]`, `sleep`, `key`, `key-combo --modifiers --key`, `type`, `touch --down --up
  --delay` steps, `swipe`/`drag --start-x ... --duration`, `button home|lock`, `slider --id|--label --value`) is in
  `axe help` of 2.0.4 with the same meaning and defaults (swipe's `--delta` default is 50 in both), so no code
  changed; the engine-off run below checks them.
- `THIRD_PARTY_LICENSES`: AXe 2.0.4, and sim-use's Apache-2.0 NOTICE and LICENSE (LY Corporation), whose keyboard
  detector AXe 2.0's `axe` binary adapts.
- Test scripts: `golden.sh` accepts the demo list's page count of any phone (3 on a Pro Max); `lab.sh` answers a
  prompt only while one is in front (below). `bench/ab.sh` and `ab-report.mjs` take more than two builds.

## Unit tests and types

`npm test`: 218 of 218 pass, on the laptop and on the Session Mac; `npm run typecheck`: clean on both.

## golden.sh and lab.sh

New build (session path) against 0.16.0 as published (its vendor/axe, engine `a95ad0aa...`), same Mac, same phones.
golden.sh has 19 tasks; lab.sh 27 checks with the engine check (26 for 0.16.0, which has none).

| Phone | golden, new | golden, 0.16.0 | lab, new | lab, 0.16.0 |
|---|---|---|---|---|
| iPhone 17 Pro | 19/19 | - | 24/27 | 24/26 |
| iPad Pro 11-inch (M5) | 18/19 | 18/19 | 24/27 | 24/26 |
| iPhone 17 Pro Max | 18/19 | 18/19 | 22/27 | 22/26 |
| iPhone 17 Pro, engine off (AXe 2.0.4's CLI only) | 19/19 | | 24/27 | |

Every miss of the new build is a miss of 0.16.0 too, or a test-script fault that fails both:

- **Location prompt** (2 checks, every phone, both builds): "Ask for location" shows no prompt on this Mac's iOS 27.2.
- **"deep link opened"** (new build on every phone's first run): `open_url` answers iOS's "Open in" itself and says
  so; lab.sh then tapped an Open button that was gone. Reproduced with 0.16.0 on an erased iPad (`app open_url` said
  `iOS asked "Open in “EdgeLab”?": answered Open.`, then `tap Open`: no "Open" on screen). 0.16.0 passed only because
  it ran second on each phone. Fixed in lab.sh.
- **Pro Max "back and scroll"**: the scroll worked ("3 pages, at 43%"); golden.sh expected 4 pages. Fixed in golden.sh.
- **iPad "back and scroll"**: "scroll down: nothing moved" on the demo's Items list, both builds. Not fixed here.
- **Pro Max "swipe a row to delete"** (2 checks): no Delete revealed, both builds. Not fixed here.
- **Engine off**: the engine check fails by design (no engine); the rest is the location prompt.

With the fixed scripts: golden on the Pro Max 19/19; lab on a freshly erased iPad 24/27, "deep link opened" passing on
a first run, the location prompt failing as before, and "text in any language" failing once: the fill left the field
at its placeholder while iOS's edit callout (Paste, AutoFill) stood over it, on a phone whose keyboard had never been
used. 0.16.0's lab on the same iPad, erased again, passed it (23/26: the location prompt and the old deep-link fault).
That one step alone, on an iPad erased before each try, the builds alternating: 6 of 6 passed, 3 each
(`logs/textcheck.txt`). A one-off, not a regression.

## A/B against 0.16.0

`bench/ab.sh` interleaved, 3 rounds, the order rotated each round, each run after a reboot, on one Bench iPhone 17 Pro
(`ab/`, `node bench/ab-report.mjs ab`). A: 0.16.0 as published (AXe 1.8.0). B: this branch packed by `npm pack`
(AXe 2.0.4), session path. C: B with `SIMULATOR_USE_ENGINE_READS=axe`. Every check passed in every run.

| Step | A median | A p90 | B median | B p90 | B vs A | C median | C p90 | C vs A |
|---|---|---|---|---|---|---|---|---|
| read | 0.37 s | 0.61 s | 0.18 s | 0.63 s | -51% | 0.13 s | 0.48 s | -66% |
| tap | 0.74 s | 1.14 s | 0.63 s | 0.72 s | -16% | 0.54 s | 0.71 s | -28% |
| fill | 1.52 s | 2.05 s | 1.26 s | 1.50 s | -17% | 1.07 s | 1.58 s | -29% |
| sign-in, step by step | 4.10 s | 6.23 s | 3.58 s | 5.38 s | -13% | 4.26 s | 5.66 s | +4% |
| sign-in, batched | 4.13 s | 5.69 s | 3.06 s | 4.60 s | -26% | 4.46 s | 5.05 s | +8% |

Rounds disagree a lot on this 8 GB virtual Mac (A's step-by-step sign-in: 3.51, 4.05, 5.87 s), so the per-call medians
and the probes below carry the reasoning, not one round. Per call (`breakdown.mjs ab`), the sign-in flows:

| First read of a relaunched app | A | B | C |
|---|---|---|---|
| step by step | 0.99 s | 0.90 s | 2.09 s |
| batched | 1.65 s | 1.05 s | 2.37 s |

The other calls of the flows are faster on B and C than on A, and within about 50 ms of each other on B and C.

The first read after each run's reboot (warm-up, one per run): A 6.4, 1.6, 18.8 s; B 10.8, 31.1, 29.6 s; C 9.6, 10.5,
10.0 s. The engine's session log says why: the first session after a reboot timed out (12 s) and was opened again
after the phone's test daemons were restarted, in 1 of A's 3 runs and 2 of B's; C's first short-lived session hit
AXe's 5 s limit each time and the next one worked. Three runs a build cannot tell 1.8 from 2.0 here (open problems).

## The read path, on numbers

`relaunch-probe.mjs` on the same phone, 8 relaunches each (`relaunch-probe.txt`): relaunch the demo, wait 1.5 s, read.

| Engine | first read after relaunch | its serializes | nodes | next read |
|---|---|---|---|---|
| A, 0.16.0 (session) | 770 to 830 ms (one 1211) | 1 | 102 | 170 to 230 ms |
| B, session | 550 to 660 ms | 1 | 102 | 80 to 115 ms |
| B, axe | 1940 to 2440 ms | 5 | 87 | 66 to 72 ms |

With a kept session a relaunched app reads at once. Without one it reads empty every time: one short-lived session
(0.42 s each, 50 of them in C's first run) and the settle loop until two reads agree. That reloaded tree also had 87
nodes, not 102 (not investigated). AXe 2.0's own path is faster on a screen already read (66 to 72 against 80 to
115 ms at the engine; 0.13 against 0.18 s and 0.54 against 0.63 s a tap through simulator-use) but slower on the
first read of every launched app, which is what agents do after every `app_run` and launch.

**Decision: the persistent-session hook stays, as the default.** It still wins where it matters (the first read of
an app: about 0.6 against 2 s; the sign-in flows: 3.58 and 3.06 s against 4.26 and 4.46 s) and reads the whole tree.
The axe path stays behind `SIMULATOR_USE_ENGINE_READS=axe` for later work (reads by display on the Duo).

**The slow per-call path fails a test.** `scripts/engine-check.mjs` passes on both paths (session: whole screen 483 ms,
point 8 ms; axe: 413 and 7 ms, on SpringBoard) and fails with the engine's `--bootstrap-every-call` (FBSimulatorControl's
default: "per-call", whole screen 1154 ms, point 453 ms, exit 1; again with the final engine on the demo's sign-in
screen: "per-call", point 422 ms, though the whole screen took only 559 ms there, under the 900 ms bound: the path's
name and the point reads are what catch it). lab.sh runs it on every phone.

## Input: connectToHID against FBSimulatorHIDSession

`hid-session-probe.patch` (a scratch build, never shipped), 40 taps alternating between the demo's two tabs, each a
screen change (`hid-probe.json`):

| Path | call returns | screen first changes |
|---|---|---|
| `connectToHID` (Indigo, the engine's) | under 1 ms | 10 to 47 ms, median 13 ms |
| `FBSimulatorHIDSession` (AXe 2's selected input) | 429 to 463 ms | within the call |

Opening the session took 287 ms. One-screen phones keep `connectToHID`; `connectToHID` in 2.0 picks Indigo unless an
active `dtuhidd` has taken the legacy HID (the ready line says which: `indigo` on every phone here).

## AXe 2.0.4's own CLI

One `bench/run.mjs --tool axe` run with `AXE_BIN` the `axe` 2.0.4 binary from vendor/axe, one process per call, on
the same phone right after the series (`axe.v2.0.4.json.gz`), against B's medians above:

| Step | AXe 2.0.4 | tokens a call | simulator-use, B |
|---|---|---|---|
| read | 0.40 s | 44,891 | 0.18 s (72 tokens) |
| tap | 0.42 s | 18 | 0.63 s |
| type (AXe: tap, then type; simulator-use: fill) | 0.49 s | 18 | 1.26 s |
| sign-in, step by step | 4.89 s | 110,339 | 3.58 s |
| sign-in, batched | 0 of 10 signed in | | 3.06 s |

AXe 2.0 sends a tap faster than simulator-use answers one (simulator-use waits for the screen to settle and reads what
changed; AXe answers once the input is sent), reads in about 0.4 s (AXe 1.8: 1.6 to 1.8 s, the engine README's table), and the bench's AXe
adapter's batch (`tap --id` and `type` steps) no longer signs in on 2.0 (not looked into: the adapter's, not ours).
simulator-use still reads faster and finishes the sign-in sooner with a tiny fraction of the tokens. The README's
"tools that start a helper for every call take 1.5 to 3 seconds" was measured against AXe 1.8 and no longer holds for
AXe 2.0; the bench's published pages need a new run before anything is said about AXe 2.0.

## Reproducible build

Two fresh clones of the branch, one in `~/drive/rb/one` and one in `/tmp/repro-second-clone-at-another-path`, each
from nothing (npm ci, AXe download, header fetch, build), gave the same bytes as the working tree's build, twice: at
`eb1ce02` (the engine every run above used) and at `f79a702` (the branch's end, which only drops an unreported counter
from the engine; golden 19/19 and engine-check passing again with it on the iPhone 17 Pro).

| Binary | sha256 at `f79a702` | at `eb1ce02` |
|---|---|---|
| `simulator-use-engine` | `138706dc989784bef566249884e42551056d2da4f5a3449cad911aa2fa256b2c` | `15c3989a934a2f2056d0dace59b6fb4f10ecad8b6544c866c1d8e76db84a732e` |
| `simulator-use-pbset` | `fe35e375bb0364c9e92100fd19ac1b80f566aacd94314d3af3cf33b077e5e2f5` | the same |
| `simulator-use-skconfig` | `7429f83e60427c4c6af9f331c5bccc2308f238b291d7e54617bddaf99bd3dca0` | the same |

The engine is ad hoc signed (no team).

## Older Xcode (decision 6, a first look)

On a laptop with Xcode 26.5 (17F42) and an iOS 26.5 iPhone 17 Pro, the engine above passed `engine-check.mjs` (ready,
whole screen 318 ms, point 7 ms; iOS 26 needs no session) and AXe 2.0.4's `describe-ui` answered (2.3 s, then 1.0 s).
Reads only: no golden or lab run there, and Xcode 27.0 not tried.

## Open problems

- **The first session after a reboot** times out at 12 s in some runs on both 1.8 and 2.0, and the engine's recovery
  (restart the phone's test daemons) costs 20 to 30 s. Worth a look with AXe 2.0's idea of waiting for the displays
  before the first accessibility request (`waitingForReadableDisplays` in its AccessibilityFetcher).
- **The axe path's reloaded tree** had 87 nodes against 102: not investigated, the path is off by default.
- **A hybrid** (the kept session for reloads, AXe 2.0's direct reads otherwise) might take both wins; not tried.
- **Pre-existing, both builds:** the iPad demo list does not scroll; the Pro Max lab cannot swipe a row to delete; the
  location prompt never shows on this Session Mac; off-screen UIKit table rows read with made-up frames.
- **The Session Mac lost its iOS runtime once** (16:25:44 UTC, right as a job ended): simdiskimaged asked cryptexd to
  unmount it ("Resource busy"), every device became "runtime profile not found", and only shutting the phones down
  and restarting CoreSimulatorService and simdiskimaged brought it back. Not seen again in the two hours after.
- The release that carries this must relabel the README's "next" hash row with its version, and decision 6 (Xcode
  26.x and 27.0 users) still needs a golden run on such a Mac before the release says what it needs.

## Files

- `ab/`: the A/B series' raw results (`simulator-use.{A,B,C}.r{1,2,3}.*`) and AXe 2.0.4's run (`axe.v2.0.4.json.gz`).
- `breakdown.mjs ab`: per-call medians of each step, per build.
- `relaunch-probe.mjs` and `relaunch-probe.txt`: the first read after a relaunch, per engine and read path.
- `hid-session-probe.patch` and `hid-probe.json`: the input comparison (a scratch build, never shipped).
- `logs/`: every golden and lab run (`*-axe2` the new build, `*-v0160`/`*-0.16.0` the baseline, `*-engineoff`,
  `*-fixed` and `*-final` after the script fixes and at the branch's end), the reproducible builds, the final
  engine-check, the text check, and the bench phone's session log (`bench-phone-session.log`).
