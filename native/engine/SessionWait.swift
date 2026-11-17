// How long the engine waits for an automation session that has not answered, decided without any framework so that
// its test (native/engine/test/session, run by test/engine-session.test.ts) needs neither a Simulator nor AXe.
//
// The signal is the phone's accessibility, read without a session (AXe 2.0's bootstrap: false) while the request
// waits (AccessibilityWatch, main.swift). Measured on iOS 27.2 (November 17, 2026, bench/results/2026-11-16-axe-2-review
// round3/signal.sh): until accessibility has loaded once since the boot, such a read fails for want of a translation
// object; it answers as the phone's testmanagerd finishes loading it ("Finished loading AX"), and that testmanagerd
// answers the session request 0.8 s later. From then on every such read answers (an app launched since reads empty,
// but answers): after sessions closed, after the phone's test daemons were restarted, with an alert up. And a
// testmanagerd that has nothing to load answers in about a second (0.3 to 1.4 s, every session opened that way).

/** testmanagerd's own limit for loading accessibility ("Waiting 120.0s for AX to finish loading"). */
let testmanagerdLoadLimitNanos: UInt64 = 120_000_000_000

/** Where a session request that has not been answered yet stands. */
enum SessionWait: Equatable {
  /** Still waited for: accessibility loaded for less than the first timeout, or still loading. */
  case waiting
  /**
   * Accessibility is loaded (when the request went out, or since) and the first timeout has passed since: the
   * testmanagerd has nothing left to do and does not answer, a phone that refuses sessions (its daemons are restarted).
   */
  case refused
  /** Accessibility is not loaded, the first timeout has passed and no testmanagerd runs: nothing is loading it. */
  case nothingLoading
  /** testmanagerd's own 120 s from the request, or the first read's deadline. */
  case outOfTime
}

/**
 * The state of a request at `now` (uptime ns): sent at `requestedAt`; `loadedAt` when a session-free read first
 * answered (nil: none yet); whether a testmanagerd runs in the phone; `timeout`, how long a testmanagerd with
 * accessibility loaded may take to answer.
 */
func sessionWait(now: UInt64, requestedAt: UInt64, loadedAt: UInt64?, daemonRunning: Bool, timeout: UInt64, deadline: UInt64) -> SessionWait {
  if now >= min(deadline, requestedAt + testmanagerdLoadLimitNanos) { return .outOfTime }
  if let loadedAt { return now < max(loadedAt, requestedAt) + timeout ? .waiting : .refused }
  return now < requestedAt + timeout || daemonRunning ? .waiting : .nothingLoading
}

/** Whether the first read still has time for a restart of the phone's test daemons and a second request. */
func timeForRestart(secondsLeft: Double) -> Bool { secondsLeft > 25 }
