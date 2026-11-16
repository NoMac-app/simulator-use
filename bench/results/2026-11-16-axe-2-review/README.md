# 0.17.0 after review: the first read after a boot, Device Hub, the release (November 16, 2026)

The review of the AXe 2.0.4 port (`../2026-11-16-axe-2`) found the first read after a phone's boot slower than
0.16.0's, the dtuhidd input path untested, and smaller faults. Everything below ran on one NoMac Session Mac (Apple M4
virtual Mac, 6 cores, 8 GB, macOS 26.6.2, Xcode 27.2 27B52, iOS 27.2 24B8117), 19:30 to 22:10 UTC, with an iPhone 17e
booted throughout beside the phone under test (as on a phone host; it also keeps the runtime mounted, see the last
section), and on a laptop with Xcode 26.5.

Builds, each run from its own copy of vendor/axe:

| | what | engine sha256 |
|---|---|---|
| A | 0.16.0 as published (AXe 1.8.0) | `a95ad0aa...` |
| B0 | the branch as reviewed (`539fdc3`) | `138706dc...` |
| B2 to B4 | intermediate builds, replaced (see below): B3 and B4 waited 30 s for the first session within two minutes of a boot; B2 to B5 sent touch by Indigo while Device Hub showed the phone | |
| B5 | the testmanagerd wait (section 1) | `1c9210f3...` |
| B6 | the release: B5 with input by dtuhidd while it runs (section 2), `a3bcc3b` | `369cb6d0...` |

## 1. The first read after a boot

`bench/first-read.mjs`: for each trial and each build, the order rotated every trial, the phone (FR iPhone 17 Pro) is
shut down and booted (`simctl boot`, `bootstatus -b`), then the engine is started and asked to describe the screen
until a read works, as NoMac's hosts do before handing a phone over (hostd boots it and calls
`simulator-use/readable`). The time is from the engine's start to the first read that worked. "Settle 20" waits 20 s
after the boot and relaunches the demo first, as `bench/run.mjs` (the review's A/B) does before its warm-up read. Raw
rows in `*/first-read.jsonl`, each with the engine's session log of that run.

**Where the time goes** (`why.sh`, `why-phone.log`: a scratch engine that waits 60 s for the first session, and the
phone's own log). The engine is ready 0.1 to 0.5 s after it starts on every build (its HID connection 7 to 54 ms,
Indigo on every run: dtuhidd does not run without Device Hub). Its first read needs an automation session, which iOS 27
needs before accessibility can be read at all. The request starts the phone's testmanagerd (launchd: "spawned
testmanagerd because ipc", 0.2 s after the request), which took 8 s to start on the busy phone, then received "request
to load Accessibility" and logged "Waiting 120.0s for AX to finish loading"; accessibility was loaded 16.6 s later, and
the session came back 26.3 s after the request. The Mac's load average was 70 to 200 on 6 cores after each boot.

**Root cause.** Every build asks at once and the phone answers when testmanagerd has loaded accessibility. 0.16.0 and
the reviewed 0.17.0 gave the request up at 12 s, restarted the phone's three test daemons (3 to 10 s) and asked again;
the second request was answered at about the time the first would have been, a little later. That 12 s limit and
restart (added on October 22 for a different fault: a phone that refuses sessions for good once one was opened too
soon after another closed) cannot tell that phone from one still loading accessibility. Nothing AXe 2.0.4 changed is in
this path: B0's engine was ready as fast as A's, on Indigo every time. In the settle mode the phone is 25 to 30 s past
its boot and the request usually answers in 5 to 12 s, but sometimes later: given up at 12 s, such a first read took 18
to 34 s. The review's three runs a build fell on that edge once for A and twice for B0; here, in ten, once for each
(and twice for A in the second run).

**Fix** (`13e3551`). When the first request is not answered in 12 s, the engine looks at the phone's testmanagerd (a
child of the phone's launchd_sim, its start time from the kernel): while one started within the last 120 s runs, the
120 s it allows itself to load accessibility, its answer is waited for. A phone whose testmanagerd is older and does not
answer is the refusing phone, and gets the restart as before; after a restart the new testmanagerd is waited for the
same way. (B3 and B4 waited 30 s within two minutes of the phone's boot: the same effect here, but a guess at the
phone's speed; hostd's notes have a phone booted at background priority readable only 192 s after its boot.)

**Right after the boot** (hostd's way), 10 trials a build in each run (`hostd/`, then `hostd-final/`):

| build | median | p90 | min to max | first session given up at 12 s |
|---|---|---|---|---|
| A, 0.16.0 | 27.2 s | 27.9 s | 24.8 to 27.9 s | 10 of 10 |
| B0, as reviewed | 26.4 s | 27.6 s | 24.3 to 27.6 s | 10 of 10 |
| B3 | 25.3 s | 26.9 s | 23.6 to 26.9 s | 0 of 10 |
| A, 0.16.0 (second run) | 27.2 s | 29.8 s | 24.1 to 29.8 s | 10 of 10 |
| B5, the fix | 27.2 s | 27.7 s | 24.2 to 27.7 s | 0 of 10 |

(B5 has the release's session code; the release, B6, differs from it only in how input is sent.) Here every build
waits for the same thing, the phone's accessibility load, and B0 is not slower than 0.16.0. Waiting
instead of restarting does not make it shorter on average (the load goes on in the phone either way); it removes the
restart's tail.

**20 s after the boot, the demo relaunched** (the review's condition), 10 trials a build in each run (`settle20/`,
then `settle20-final/`):

| build | median | p90 | min to max | first session given up at 12 s |
|---|---|---|---|---|
| A, 0.16.0 | 7.8 s | 34.2 s | 6.1 to 34.2 s | 1 of 10 |
| B0, as reviewed | 6.4 s | 29.9 s | 5.8 to 29.9 s | 1 of 10 |
| B4 | 6.4 s | 18.8 s | 5.7 to 18.8 s | 0 of 10 |
| A, 0.16.0 (second run) | 7.0 s | 33.2 s | 6.0 to 33.2 s | 2 of 10 |
| B5, the fix | 6.4 s | 7.3 s | 5.8 to 7.3 s | 0 of 10 |

The reviewed build was not slower than 0.16.0 here either (median 6.4 against 7.8 s, one restart each); its 31.1 and
29.6 s in the review were two restarts in three runs. With the fix no first read took over 7.3 s.

## 2. Input while Device Hub shows the phone (dtuhidd)

Opening Device Hub starts `dtuhidd` in every booted phone; quitting it shuts the phones down. Two probes, with Device
Hub showing the phone: `input-probe.mjs` (on the demo's sign-in screen: tap each field, type into it, read it back,
then 10 taps) and `tab-probe.mjs` (tap the Items tab, read the screen, tap the Login tab, read it, three times: whether
each tap landed).

| build, way in | tap | taps landed | type 16 characters | text arrived |
|---|---|---|---|---|
| A, 0.16.0 (AXe 1.8's Indigo) | 80 to 90 ms | 6 of 6 | 595 ms | yes |
| B0, AXe 2.0.4's `connectToHID` (dtuhidd, AXe's own send) | 381 to 395 ms | yes | 906 ms | yes |
| `--hid dtuhid` with AXe's own send | 381 to 407 ms | 6 of 6 | 1036 ms | yes |
| AXe 2.0.4's Indigo (`--hid indigo`, and the first `auto`'s touch) | 0 to 7 ms | 0 of 3 in the second run (the first run's field taps did land) | refused: `keyboardSuppressedByActiveDTUHIDD` | no |
| B6, the release: auto, dtuhidd on the kept connection | 0 to 3 ms (the first 237 ms, with the 219 ms connection) | 6 of 6 | 506 ms | yes |

So the reviewed build sent every tap through dtuhidd whenever Device Hub showed the phone, about 380 ms each: AXe's
send waits 380 ms after each gesture so that its command line, one process per call, does not close the connection
before the phone has the events. A first fix (`auto` sending touch by Indigo and only keys by dtuhidd) looked right in
a first run (taps landed) but in a later one, with Device Hub showing the phone, AXe 2.0.4's Indigo taps were sent and
none landed: lab.sh 5 of 27 (`lab-hub-B5.log`). AXe's own rule, dtuhidd for everything while it runs, is the reliable
one; what cost the time was its per-gesture wait, which a process that keeps its connection does not need.

**Fix** (`18a326c`, Input.swift): before every input the engine looks whether dtuhidd runs in the phone; while it does,
input goes by dtuhidd on a connection the engine opens at the first such input (AXe's open, which waits for the phone:
about 220 ms) and keeps while that dtuhidd runs, each piece sent and confirmed by the phone in turn (AXe's
`sendAsync`), with AXe's pacing of keys (10 ms after each, 50 ms after the last) and without the 380 ms wait;
otherwise by Indigo as before. A read needs neither, so the engine never waits for dtuhidd at its start (AXe's
`connectToHID` could wait up to 10 s). `--hid` or `SIMULATOR_USE_ENGINE_HID` forces `indigo` or `dtuhid`; the ready
line says `hid` (the way input goes now), `hid_choice` and `dtuhidd`, and each input's answer says `via`.

**lab.sh with Device Hub open:** with the first fix (B2), 24 of 27: the location prompt (2 checks, never shown on this
Mac, every build) and "text in any language". That step alone, 4 rounds each, failed 4 of 4 with 0.16.0 too
(`textcheck-hub.txt`): with Device Hub open, `simctl pbcopy`'s text never reaches the phone (Device Hub keeps the
phone's clipboard in step with the Mac's; `simctl pbpaste` read it back empty), so every paste left the field as it
was. **Fix** (`d68710c`): the clipboard is read back after `pbcopy` and set from inside the phone
(`simulator-use-pbset`) when it differs; then 3 of 3 (`textcheck-hub-B3.txt`). With the release (B6): lab.sh 25 of 27
with Device Hub open, only the location prompt failing (`lab-hub-B6.log`), and 25 of 27 headless (section 5).

## 3. golden.sh and lab.sh with B5, headless

| phone | golden.sh | lab.sh |
|---|---|---|
| iPhone 17 Pro | 19 of 19 | 25 of 27 |
| iPhone 17 Pro Max | 19 of 19 | |

lab.sh's two misses are the location prompt, which never shows on this Mac's iOS 27.2 with any build. golden.sh checks
the list's page count per phone again (4 on the iPhone 17 Pro, 3 on the Pro Max; on any other phone, the count the
list shows at its top), and both passed it. `npm test`: 219 of 219.

## 4. Xcode 26.5 (the laptop)

The packed 0.17.0 (the tarball of section 5, its own bin, dist and vendor/axe, with the repository's scripts and
examples beside them; `laptop-test.sh`) on a MacBook with Xcode 26.5 (17F42) and an iOS 26.5 iPhone 17 Pro, the one
Simulator running: golden.sh 19 of 19 (`laptop-xcode265-golden.log`), lab.sh 24 of 27 (`laptop-xcode265-lab.log`),
the engine on its fast path there too. The misses: the location prompt (as on the Session Mac) and "web view called
unreadable": iOS 26.5 gives the SwiftUI web view's page, and simulator-use read its field, button and text, where the
check expected iOS 27's unreadable view. lab.sh now accepts either (`80f060b`). So AXe 2.0.4's frameworks and the
engine built with Xcode 27.2's Swift run with Xcode 26.5: reads, taps, typing, builds, tests, logs, crashes and video.
The test apps were removed and the phone shut down after.

## 5. The release tarball

`pack.sh` on the same Mac: a fresh clone of GitHub's main with the branch's commits at `a3bcc3b` (0.17.0), `npm ci`,
`npm pack` (its prepack fetched AXe 2.0.4, checked its sha256, built the native parts with Swift 6.4.2,
swiftlang-6.4.2.1.9, and built dist). `simulator-use-0.17.0.tgz`: 16,762,585 bytes, sha256
`125ae93f8c38dad405d1338b88a05224b9947c0990bc60c24028c3c49aaf8445`, 155 files. Its native parts are the README's 0.17.0
row (engine `369cb6d0c31194cb47eefcd7084108b06ff5cafe9848079f4064bf2f51c223d2`, pbset `fe35e375...`, skconfig
`7429f83e...`), the same bytes as the B6 engine built in the working clone at another path; every binary is 0755
(`tar -tvzf`), the engine ad hoc signed, `axe --version` 2.0.4. golden.sh and lab.sh from that clone, headless on an
iPhone 17 Pro: golden 19 of 19, lab 25 of 27 (the location prompt), the engine on its fast path (`golden-final.log`,
`lab-final.log`). The Session Mac was stopped at 22:10 UTC.

## The runtime lost at a shutdown

Once (19:41:06 UTC), shutting down the only booted phone made simdiskimaged ask cryptexd to unmount the iOS 27.2
runtime; cryptexd answered "Resource busy" twice and simdiskimaged forced the unmount ("Performing a cryptex force
unmount after 2 tries"), after which every device read "unavailable, runtime profile not found" and the next boot hung.
Shutting everything down and killing CoreSimulatorService and simdiskimaged brought it back
(`runtime-lost-1.log`). With a second phone kept booted the runtime stayed mounted, and it did not happen again in
over 100 reboots.

## Files

- `../../first-read.mjs` (bench/): the measurement; `node bench/first-read.mjs --report DIR` prints the medians.
- `hostd/`, `settle20/`, `hostd-final/`, `settle20-final/`: its rows, and `*.log` as printed; `sanity5/` one run of B5.
- `diag.patch` (a scratch engine whose first-session wait and daemon restarts come from the environment), its rows in
  `diag1/`, and `why.sh` with `why-phone.log`: the phone's own log of a first session after a boot.
- `input-probe.mjs`, `tab-probe.mjs`, `keys-after-hub.mjs`, `textcheck.sh` and their outputs (`input-probe-hub.txt`,
  `textcheck-hub*.txt`).
- `lab-hub-B2.log`, `lab-hub-B3.log`, `lab-hub-B5.log`, `lab-hub-B6.log`: lab.sh with Device Hub open;
  `golden-iPhone17Pro.log`, `golden-iPhone17ProMax.log`, `lab-iPhone17Pro.log` (B5) and `golden-final.log`,
  `lab-final.log` (the release clone): headless. `regress.sh`, `pack.sh`: how they and the tarball were made.
- `runtime-lost-1.log`: simdiskimaged and cryptexd when the runtime was lost.
- `laptop-test.sh`, `laptop-xcode265-golden.log`, `laptop-xcode265-lab.log`: section 4.
