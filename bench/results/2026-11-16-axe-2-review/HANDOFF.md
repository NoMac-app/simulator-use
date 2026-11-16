# Handoff: 0.17.0 on hold (November 16, 2026, 23:30 UTC)

Branch `axe-2` in `~/simtap-axe2`, all committed; nothing pushed. The tarball made at `a3bcc3b`
(`simulator-use-0.17.0.tgz`, sha256 `125ae93f...`) is **superseded**: the engine changed since (B1, I1, I2), so the
tarball must be rebuilt (and the README's 0.17.0 row re-hashed) after the open point below is settled. No Session Mac
is running (the last one, ses_81f8a421..., was stopped at 23:24 UTC).

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
