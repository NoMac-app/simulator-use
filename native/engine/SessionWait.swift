// How long the engine waits for an automation session that has not answered, decided without any framework so that
// its test (native/engine/test/session, run by test/engine-session.test.ts) needs neither a Simulator nor AXe.
//
// The signal is the phone's accessibility, read without a session (AXe 2.0's bootstrap: false) while the request
// waits (AccessibilityWatch, below). Measured on iOS 27.2 (November 17, 2026, bench/results/2026-11-16-axe-2-review
// round3/signal.sh): until accessibility has loaded once since the boot, such a read fails for want of a translation
// object; it answers as the phone's testmanagerd finishes loading it ("Finished loading AX"), and that testmanagerd
// answers the session request 0.8 s later. From then on every such read answers (an app launched since reads empty,
// but answers): after sessions closed, after the phone's test daemons were restarted, with an alert up. And a
// testmanagerd that has nothing to load answers in about a second (0.3 to 1.4 s, every session opened that way).
import Foundation

/** testmanagerd's own limit for loading accessibility ("Waiting 120.0s for AX to finish loading"). */
let testmanagerdLoadLimitNanos: UInt64 = 120_000_000_000

/**
 * What a first request leaves of the first read's budget for a restart of the phone's test daemons and a second
 * request: timeForRestart's 25 s, and a second for the request's last check (sessionPollSeconds) and the end of its
 * watch (watchStopSeconds). A first request stops waiting for accessibility to load that long before the deadline, so
 * a testmanagerd stuck before its first load is restarted, not waited for to the deadline command after command. That
 * still leaves the load 74 s of the 100 s budget; the longest load measured took 31 s.
 */
let restartReserveNanos: UInt64 = 26_000_000_000
/** How often a waiting request looks at where it stands. */
let sessionPollSeconds = 0.25
/** How long an unanswered request waits for its watch's read in flight before going on (to a restart). */
let watchStopSeconds = 0.5

/** What a read of the phone's accessibility without a session says. */
enum AccessibilityRead: Equatable {
  /** It answered: accessibility is loaded. */
  case loaded
  /** It failed for want of a translation object: the one answer of a phone whose accessibility has not loaded since its boot. */
  case notLoaded
  /** Any other failure, or no answer within its time: no evidence either way. */
  case unknown
}

/** A read's verdict from its error (nil: it answered). */
func accessibilityRead(error: String?) -> AccessibilityRead {
  guard let error else { return .loaded }
  return error.contains("No translation object") ? .notLoaded : .unknown
}

/** Where a session request that has not been answered yet stands. */
enum SessionWait: Equatable {
  /** Still waited for: accessibility loaded for less than the first timeout, or still loading. */
  case waiting
  /**
   * Accessibility is loaded (when the request went out, or since) and the first timeout has passed since: the
   * testmanagerd has nothing left to do and does not answer, a phone that refuses sessions (its daemons are restarted).
   */
  case refused
  /**
   * Accessibility is not loaded and the first timeout has passed, and nothing is loading it: no testmanagerd runs, or
   * the last read without a session did not fail the not-loaded way (another error, or no answer in its time).
   */
  case nothingLoading
  /** Still loading at `loadUntil`: a first request gives up with the time for a restart and a second request left. */
  case loadTooLong
  /** testmanagerd's own 120 s from the request, or the first read's deadline. */
  case outOfTime
}

/**
 * The state of a request at `now` (uptime ns): sent at `requestedAt`; `loadedAt` when a session-free read first
 * answered (nil: none yet); `loading`, whether the last one failed the not-loaded way; whether a testmanagerd runs in
 * the phone; `timeout`, how long a testmanagerd with accessibility loaded may take to answer; `loadUntil`, when a
 * request still waiting for the load stops (loadWaitEnd).
 */
func sessionWait(now: UInt64, requestedAt: UInt64, loadedAt: UInt64?, loading: Bool, daemonRunning: Bool, timeout: UInt64, deadline: UInt64, loadUntil: UInt64? = nil) -> SessionWait {
  if now >= min(deadline, requestedAt + testmanagerdLoadLimitNanos) { return .outOfTime }
  if let loadedAt { return now < max(loadedAt, requestedAt) + timeout ? .waiting : .refused }
  if loading, let loadUntil, now >= loadUntil { return .loadTooLong }
  return now < requestedAt + timeout || (daemonRunning && loading) ? .waiting : .nothingLoading
}

/** When a request stops waiting for the load: a first one (a restart may follow) leaves restartReserveNanos. */
func loadWaitEnd(deadline: UInt64, restartMayFollow: Bool) -> UInt64? {
  restartMayFollow ? deadline - min(deadline, restartReserveNanos) : nil
}

/** Whether the first read still has time for a restart of the phone's test daemons and a second request. */
func timeForRestart(secondsLeft: Double) -> Bool { secondsLeft > 25 }

/**
 * Reads of the phone without a session while a session request waits: one at a time, a second apart, from the request
 * until the first that answers, whose time is `loadedAt` (uptime ns). Only reads: no session, no bootstrap, no
 * remediation beyond what every read does. Each read has `readLimit`: one still going past it is no evidence of
 * loading, and nothing waits for it (a hung read never holds the request).
 */
final class AccessibilityWatch: @unchecked Sendable {
  private let lock = NSLock()
  private var loaded: UInt64?
  private var last = AccessibilityRead.unknown
  /** When the read in flight passes its limit (uptime ns); nil between reads. */
  private var readEnds: UInt64?
  private var stopped = false
  private let finished = DispatchSemaphore(value: 0)
  private let readLimitNanos: UInt64
  private var task: Task<Void, Never>?
  var loadedAt: UInt64? { lock.lock(); defer { lock.unlock() }; return loaded }
  /** The last read failed for want of a translation object, and the one in flight (if any) is within its limit. */
  var loading: Bool {
    lock.lock(); defer { lock.unlock() }
    return last == .notLoaded && (readEnds.map { DispatchTime.now().uptimeNanoseconds < $0 } ?? true)
  }
  init(readLimit: Double = 5, every interval: Double = 1, read: @escaping @Sendable () async -> AccessibilityRead) {
    readLimitNanos = UInt64(readLimit * 1e9)
    task = Task.detached { [self] in
      while self.beginRead() {
        if self.endRead(await read()) { break }
        try? await Task.sleep(nanoseconds: UInt64(interval * 1e9))
      }
      self.finished.signal()
    }
  }
  private func beginRead() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if stopped { return false }
    readEnds = DispatchTime.now().uptimeNanoseconds + readLimitNanos
    return true
  }
  /** Whether that read found accessibility loaded (the watch is done). */
  private func endRead(_ verdict: AccessibilityRead) -> Bool {
    lock.lock(); defer { lock.unlock() }
    readEnds = nil
    if stopped { return true }
    last = verdict
    if verdict == .loaded { loaded = DispatchTime.now().uptimeNanoseconds }
    return verdict == .loaded
  }
  /**
   * Ends the reads (the pause between two at once: the task is cancelled); returns once the read in flight has (it
   * should not overlap the engine's own reads), at its limit, or at `deadline`, whichever comes first.
   */
  func stop(until deadline: DispatchTime) {
    lock.lock(); stopped = true; let ends = readEnds.map { DispatchTime(uptimeNanoseconds: $0) }; lock.unlock()
    task?.cancel()
    _ = finished.wait(timeout: min(deadline, ends ?? deadline))
  }
}
