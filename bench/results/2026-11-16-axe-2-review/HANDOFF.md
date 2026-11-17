# Handoff: 0.17.0 ready for release (November 17, 2026, 10:30 UTC)

## Round 4 (November 17, 2026): two review findings fixed, tarball rebuilt (the current state)

- `21f2fd4` set: holdSlider's try starts before the first move; after any move that may have gone out (busy,
  partial, lost) the finger is lifted, by `liftFinger` (the engine's drag with steps 0, down false: an up alone, so
  it taps nothing where no finger is down), and a lift's error never hides the move's. `test/hold-slider.test.ts`
  (stand-in engine `test/fixtures/fake-engine-finger.mjs`): 4 tests, all 4 fail on the code before.
- `e4c2b39` session wait: a first request stops waiting for a load at the deadline less 26 s
  (`restartReserveNanos`), so a restart always fits (the load keeps 74 s); only "No translation object" counts as
  not loaded (other errors, or a read past its 5 s limit, are no evidence: given up after the first timeout);
  `AccessibilityWatch` (moved to SessionWait.swift) never waits for a hung read past its limit, and an unanswered
  request gives the read in flight 0.5 s. Swift test extended; with the old behaviour put back 7 checks fail.
- `ad4f8dd` README: engine `06b2da40a3aeae5ae4d778587b1191d73a4479a2b5aff1c499dae19f5d78574e` (helpers unchanged).
- `npm test` 227 of 227 and typecheck clean (laptop and a Session Mac, Xcode 27.2). lab.sh iPhone 17 Pro
  27 of 27 ("set a slider" 6 s, 0 session timeouts). First read right after boot, 5 each interleaved: B11
  (a78b9322) median 14.3 s (12.0 to 15.7), new engine median 14.8 s (12.2 to 16.9), 0 timeouts either; one new-engine
  trial waited past 12 s on "No translation object" and answered at 16 s (the signal still read right).
- Tarball (`pack.sh`, fresh clone + bundle at `ad4f8dd`): `simulator-use-0.17.0.tgz`, sha256
  `2ea55c56d3cc64818b2d8dbbca47fbdcbab6ef32ba14653dce3cc32823b737dc`, 16,778,485 bytes; engine hash as in the README
  (same as the branch build), modes 0755, ad hoc signed, AXe v2.0.4. Supersedes `e75480f2...`. Mac stopped.
- Duo branch: also needs `21f2fd4` and `e4c2b39` (then its own README hash).

Branch `axe-2` in `~/simtap-axe2`, committed locally (`828dbd8` tests_run cherry-pick, `0fd6624` session wait,
`2c56c3b` lab.sh, `bda3627` slider, `683c517` README hash, then this file and round 3's logs); nothing pushed, tagged
or published. **Round 3 below is the current state**: the open points of November 16 (sections B1 to Next steps,
kept as they were) are settled there. The release tarball is rebuilt (`e75480f2...`, round 3's last items); the one
made at `a3bcc3b` (`125ae93f...`) is superseded. No Session Mac is running (stopped 09:42 UTC).

## B1: the first session's wait (state)

- `13e3551` waited for any testmanagerd younger than 120 s. Mac 7 (Duo lab): after a recovery restart, the next
  engine met that young daemon, which never answered: 120 s a command, then a restart, answered in about 1 s.
- `bc32efe` (now): a testmanagerd that was there as the request went out (same pid) and does not answer in 12 s is a
  refusing phone: restart at 12 s, as 0.16.0 did. Only a testmanagerd whose pid differs (started for this request) is
  waited for, up to its own 120 s and the first read's 100 s budget. The restart now runs under the session turn,
  so one engine's restart can no longer kill another engine's request in flight (the likely way the Mac 7 waits
  chained command after command). Decision code in `native/engine/SessionWait.swift`, tested by
  `test/engine-session.test.ts` (compiles it with swiftc, no frameworks).
- **Not settled:** the coordinator's last evidence says even a daemon started by the request can be stuck after a
  restart/alert (Mac 7 reopened in about 1 s after restarts, so a restart wins there), and asks for a positive signal
  of accessibility load progress rather than "started by this request". Not chosen yet. What is known:
  - Right after a boot (phone log, `why-phone.log`): launchd spawns testmanagerd 0.2 s after the request; it logs
    nothing for 8 s (starting under load), then "Received request to load Accessibility", "Waiting 120.0s for AX to
    finish loading", and "Received kAXAccessibilityLoaded" 16.6 s later; the session answers 26.3 s after the request.
  - Mac 7's stuck case ends at "open failed in 120791 ms": that is testmanagerd's own 120 s AX wait, so a stuck
    daemon most likely also logs "Waiting 120.0s for AX": the AX wait line alone does not tell loading from stuck.
  - Candidate signals to test next: (a) whether accessibility is already loaded (a session-free read, AXe 2.0's
    `bootstrap: false`, answers): after a boot it does not until the first load; if it answers, a waiting
    testmanagerd is not doing first-load work, so restart; (b) the phone's boot age (`lastBootedAt`): genuine first
    loads happen only after a boot; (c) other processes' AX activity in the phone's log during the wait.
  - Not reproduced here: on a Session Mac (Apple M4 virtual, iOS 27.2) no permission alert (contacts, location,
    notifications, left up or answered) made any session hang: alert-probe (`round2/B-contacts`) opened sessions in
    0.4 to 1.4 s with the alert up, and lab runs logged 27 to 28 sessions with 0 timeouts and 0 restarts
    (`round2/lab-*.session.log`). `round2/stuck.sh` (restart the daemons with and without an alert up, then new
    engines, 0.16.0 against the candidate, with the phone's testmanagerd log) was written but not run.
- Measured before this change (first round, same branch, `README.md` section 1): right after a boot A 27.2 s median vs
  the waiting build 27.2 s (no gain there); 20 s after the boot A 7.0 s median with 30 to 34 s tails (2 of 10) vs the
  waiting build 6.4 s, max 7.3 s. The current build (`bc32efe`) has not been benchmarked: `round2/fr-final.sh` is the
  script (A vs the candidate, 10 trials each, both conditions).

## The alert root cause (so far)

Not found: it did not reproduce on a Session Mac (above). The Mac 7 pattern (every new engine refused after the alert,
0.16.0 too at 12 s + a restart per command) needs Mac 7's own logs: per refused request, `xcrun simctl spawn <udid>
log show --start ... --predicate 'process == "testmanagerd" OR (process == "launchd_sim" AND eventMessage CONTAINS
"testmanagerd")'`, to see whether testmanagerd got the request, started an AX load, and what it waited on.

## lab.sh on this Session Mac (B9 = `bc32efe`'s engine)

iPhone 17 Pro 14 of 27; the misses are not sessions (27 ok, 0 timeouts, 0 restarts): (1) "set a slider" ends at
0.72 for 75 in every lab run on this Mac (0.16.0 and 0.17.0 both set it outside lab: `set #volume 30/75`, 4 of 4
each, 0.17.0 15.5 s against 9.7 s: AXe 2.0.4's slider plus corrections); (2) the location prompt never appears in lab
here even on a fresh install with a location set (it did appear in a manual run: `round2/B-contacts`); (3) "text in
any language" fails on a phone whose keyboard was never used, and the keyboard left up covers the tab bar, failing
the rest in cascade. iPad and Pro Max runs were cut short (Mac stopped). These need their own look before lab counts
as passing; `lab.sh` (`420c2b4`) now starts from a fresh install, sets a location and waits 20 s for the prompt.

## I1, I2, minors

- I1 done in `bc32efe`: `sessionBudget` 100 s for all the first read's session work (under HUNG_MS 120 s,
  `src/engine/native.ts` says so); the lock is waited for up to that deadline (open and close); "half a minute"
  comment gone.
- I2 done in `bc32efe`: `PhoneInput.sent` set as the first piece goes out; failed answers carry `input_sent` and
  `via`; `batch`, `gesture`, `pressButton` (`src/engine/axe.ts`) call the engine with `reportLost` and throw instead of
  falling back to AXe when `input_sent` or `lost`; `read.ts`'s settle_read already followed `input_sent`.
- Minors: `via`/`dtuhid_connect_ms` reset per request (`beginRequest`) and reported on failures; launchd_sim's pid
  re-checked by its UDID argument, one FBProcessFetcher; paste trusts pbcopy when pbpaste fails without the helper,
  exact read-back tested (`84ca28f`).
- `npm test` 221 of 221, typecheck clean (laptop).

## The Duo branch

`duo` already has `13e3551` and `62cecb8` (the age rule). It needs `bc32efe` (and `84ca28f`) cherry-picked, after the
open point above; `bc32efe` touches `native/engine/main.swift` (openSession, the hook, the lock), `Input.swift`
(`sendPieces`, `sent`, `beginRequest`/`report`), `build.sh` (adds `SessionWait.swift`) and `src/engine/axe.ts`.

## Next steps

1. Run `round2/stuck.sh` for 0.16.0 and the candidate on a Session Mac; get Mac 7's testmanagerd log for a refused
   request (above); pick the progress signal (try (a) first) and replace `unansweredSession`'s pid rule with it;
   extend the Swift test.
2. Benchmark with `round2/fr-final.sh`: both conditions, 10 trials each, against 0.16.0; report boot (loading) and a
   stuck case (after a restart / alert) separately.
3. lab.sh on iPhone 17 Pro, iPad, Pro Max: understand the slider, the location prompt and the first-use keyboard
   paste on that Mac (or run on another host), until only known misses remain.
4. Rebuild the tarball on a Session Mac (`pack.sh` in the first round's folder), re-hash the README's 0.17.0 row,
   verify as before, then the Xcode 26.5 check on the laptop again.

## Round 3 (November 17, 2026): the state now

- **Cherry-picked** `8429fae` from `tests-on-the-phone` as `828dbd8` (tests_run passes `-parallel-testing-enabled NO`:
  the root cause of phones shut down and tests run on "Clone 1 of ..." on NoMac hosts). No conflict; `npm test` 223 of
  223. It goes into the 0.17.0 tarball.
- **B1, the signal (measured, `round3/signal.sh`, a Session Mac, iPhone 17 Pro, iOS 27.2):** a read
  without a session (`--no-bootstrap`) fails with "No translation object" from the boot until the phone's
  accessibility is readable (8.6 s after one boot, 31 s after another), then answers; after sessions closed, after a
  restart of the test daemons and with an app launched since (which reads as an empty app) it answers. So "a
  session-free read answers" = accessibility loaded, and testmanagerd has nothing left to load.
- **B10** (uncommitted until benchmarked): `unansweredSession`'s pid rule replaced by `sessionWait`
  (`SessionWait.swift`): session-free reads run beside the request (`AccessibilityWatch`, main.swift); once one
  answers (at once when accessibility was loaded before), testmanagerd has the first timeout (12 s) to answer, else
  refused (restart); while none answers it is loading and is waited for while it runs (its 120 s, the 100 s budget).
  Induced stuck daemon (`round3/stuck-bench.sh stuck`: the request's testmanagerd SIGSTOPped as it starts): B10
  refuses at 12.2 s ("accessibility loaded 2 ms after the request") and restarts, like 0.16.0.
- **Measured so far (round 3, iPhone 17 Pro):** after a restart of the test daemons ("plain"), 10
  trials each: 0.16.0 1.8 to 1.9 s, B10 2.0 to 2.4 s (open 0.92 s both; B9 against B10, 5 each: 1.8 to 2.2 s both, so
  the gap is 0.17.0's, not the watch's). Stuck daemon, 10 each: 0.16.0 23.9 to 24.5 s, B10 23.9 to 25.2 s (both
  refuse at 12.0 to 12.2 s; the second open waits about 8.4 s for launchd's respawn throttle of the killed daemon);
  B9 (bc32efe) 2 trials: read failed at 100.1 s (waited for the young stuck daemon). Committed as `0fd6624`.
- **Lab, location prompt (lab wrong):** `run` grants every permission simctl can by default (`8fb3331`, October 23),
  so locationd had EdgeLab "authorized when in use" (auth 4, `_CLDaemonSetAuthorizationStatusByType`) before the
  tap, and iOS asked nothing. lab.sh now runs EdgeLab with `--permissions ask`.
- **Lab, slider (real bug):** measured (`round3/slider-probe.mjs`, Pro Max): the SwiftUI slider follows a finger only
  after about 10 pt of travel, then point for point (9 pt: no move; 15 pt: 4.6 pt; 25 pt: 14 pt; long drags 1 to 5
  points short). AXe 2.0.4's slider command took 15 s and stopped part way ("Input stopped") on the Pro Max, and
  our correcting drags of a few points could never move it: 72 for 75. Fix: the engine's drag takes `down`/`up`
  (a finger held between calls); `set` puts a finger on the thumb, moves it, reads the slider while holding it and
  moves again by the shortfall, then lifts (AXe's slider only without the engine).
- **Lab, first paste (open):** on the Pro Max's first boot on this Mac, Cmd-V never pasted (Cmd-A worked; the
  clipboard was right, set by pbcopy and by the in-phone helper; by dtuhidd and by Indigo; 0.16.0's engine and AXe's
  CLI alike; no paste request reached `pasted`). After a reboot of that phone every paste worked, and on the 17 Pro
  (rebooted many times by then) 5 of 5 worked, also right after AXe's slider started dtuhidd. Being narrowed down
  (first boot of a new device, or the app's first launch).
- Session Mac runtime loss (known, fix pending rollout) hit once at 07:45 UTC: `round3`'s `fixrt.sh` restarts
  CoreSimulatorService and simdiskimaged when the runtime is gone.
- **Boot benchmark (round 3, `round3/fr3.sh`, iPhone 17 Pro, 10 trials each, interleaved):** right after the boot
  (hostd's way): 0.16.0 median 27.1 s (p90 29.1, 20.3 to 29.1; a session timeout and restart in all 10), B10 median
  17.8 s (p90 23.0, 11.5 to 23.0; none). 20 s after the boot, demo relaunched: 0.16.0 median 13.6 s (p90 25.7, 6.3
  to 25.7; timeouts in 4), B10 median 9.3 s (p90 11.3, 3.8 to 11.3; none).
- **First paste:** not a first boot: a new iPhone 17 Pro's first boot pasted 3 of 3 (first launch, relaunch, after a
  reboot; `round3/paste-first-boot.sh`). What broke the Pro Max came earlier in that sequence; the likeliest is AXe's
  slider command failing part way through its drag by dtuhidd after 15 s (AXe's own "Input stopped. Some input may
  have been sent"), a finger possibly left down; not reproduced after a reboot (AXe's slider failed the same way and
  the paste after it worked). With the engine, `set` no longer runs AXe's slider.
- **lab.sh with the fixes (B11 = `bda3627`'s engine a78b9322, dist rebuilt; `round3/lab-B11b-*.log`):** iPhone 17 Pro
  27 of 27, iPad Pro 11-inch (M5) 27 of 27, iPhone 17 Pro Max 25 of 27. ("set a slider" 6 s.) A first B11 run with a
  stale dist (bin/simulator-use.js runs dist/, so the old slider code ran) failed the slider on both iPhones, and the
  iPad's two pastes after AXe's slider command had run on it; with the new `set` (no AXe slider) every paste passed.
- **Pro Max's two misses (pre-existing, not fixed):** `swipe left "Row 3"` is a 0.3 s swipe over 70% of the row
  (sweepIn, unchanged since 0.6.0), and on the Pro Max iOS took it as a full swipe: Row 3 deleted outright, no Delete
  button (3 of 3; "delete it" then fails). Measured (`round3/swipe-dist.mjs`, 0.3 s swipes centred on a row): Pro Max
  (row 400 pt) 30, 40, 50% showed the actions, 60% deleted; iPhone 17 Pro (370 pt) 30, 40% showed, 50% deleted (yet
  70% showed them in every 17 Pro lab run: the outcome depends on speed as well). A shorter reveal swipe (30 to 40%)
  is the likely fix, but the same gesture pages carousels: golden.sh on each phone must pass with it first. Owner's
  call; not in 0.17.0.
- **The 0.17.0 tarball (rebuilt at `683c517`, `pack.sh` on a Session Mac: Xcode 27.2, Swift 6.4.2 swiftlang-6.4.2.1.9,
  a fresh clone of GitHub main plus this branch from a bundle):** `simulator-use-0.17.0.tgz`, sha256
  `e75480f2dcb0be8a49d65bf9c55e569d4542d224c2f307df1aa799029bd01624`, 16,776,555 bytes, in the session's scratchpad.
  Engine `a78b9322b93245133d160aa7affde486b3fbd212073f84c53c1c50698d3ca932`, pbset `fe35e375...`, skconfig
  `7429f83e...`: all three in the README's 0.17.0 row (the build is reproducible: the same engine hash from the
  branch build and the clean clone). Modes 0755 (axe, the three helpers, FBSimulatorControl, bin), engine ad hoc
  signed, AXe v2.0.4, package.json 0.17.0, dist has `-parallel-testing-enabled` (tests_run) and holdSlider. Supersedes
  `125ae93f...`.
- **The tarball checked:** golden.sh against the packed tarball on the Session Mac: iPhone 17 Pro 19 of 19, iPhone 17
  Pro Max 19 of 19 (`round3/golden-tgz.log`; "the tests pass" there is tests_run with `-parallel-testing-enabled NO`).
  On the laptop (Xcode 26.5, iOS 26.5, iPhone 17 Pro, `laptop-test.sh`): golden.sh 19 of 19, lab.sh 27 of 27
  (`round3/laptop-xcode265-*.log`). A first laptop run hit "No space left on device" (2.9 GB free at its start) and
  failed two golden checks on the build database; the rerun, with 5.5 GB free, passed everything.
- **Duo branch (not touched):** needs `bc32efe` and `84ca28f` (as before) and now `0fd6624` (session wait; it replaces
  `bc32efe`'s pid rule in SessionWait.swift and openSession), `bda3627` (slider; engine drag op and ui-act.ts) and
  `2c56c3b` (lab.sh), then its own engine hash in its README row.
- **Still open, owner's call:** the Pro Max full swipe (above); the alert refusals seen only on Mac 7 (no refusal after
  an alert on this Session Mac either: round 2's `stuck.sh` with 0.16.0: with EdgeLab's location alert up, two new engines opened
  sessions in 417 and 422 ms; the run's later steps were cut short by the runtime loss); dtuhidd also runs in a phone without Device Hub once AXe's CLI has used it (seen here: AXe's
  `slider` started it), so "by dtuhidd while Device Hub shows the phone" in Input.swift's comment is not the only case
  (input then goes by dtuhidd, and every lab check passed that way).
