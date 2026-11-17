// How long the engine waits for an automation session that has not answered, decided without any framework so that
// its test (native/engine/test/session, run by test/engine-session.test.ts) needs neither a Simulator nor AXe.
//
// The signal is testmanagerd's own account of loading accessibility, from the phone's log while the request waits
// (LoadLog, below): "Beginning AX loading sequence." as it starts, "Finished loading AX." as it ends, and it answers the
// session request about a second after that. iOS 26.5's and 27.2's testmanagerd log the same lines.
//
// Never a read of the phone's accessibility: a translation request that reaches a phone before its accessibility is
// loaded leaves the phone's CoreSimulatorBridge an unknown accessibility client ("App accessibility not enabled",
// "Unknown client: CoreSimulatorBridge", "Could not auto-register for pid status change", its own log), and from then
// on it answers every translation request, from any process, with nothing ("No translation object returned"), though
// testmanagerd loaded accessibility and the session is open, until the bridge restarts (November 17, 2026, a phone
// booted at background priority beside a live one: 0.17.0, whose watch read the phone every second while it waited,
// failed every first read of 240 s; 0.16.0, which never read before the session, read every time, and failed the same
// way once another process read the phone during its load; restarting com.apple.CoreSimulator.bridge mended it within
// seconds). AXe found the same on iOS 27.2: one read in the first seconds after a boot poisons the phone (AXe d8422e2).
import Foundation

/** testmanagerd's own limit for loading accessibility ("Waiting 120.0s for AX to finish loading"). */
let testmanagerdLoadLimitNanos: UInt64 = 120_000_000_000

/**
 * What a first request leaves of the first read's budget for a restart of the phone's test daemons and a second
 * request: timeForRestart's 25 s, and a second for the request's last check (sessionPollSeconds) and the end of its
 * log. A first request stops waiting for accessibility to load that long before the deadline, so a testmanagerd stuck
 * in its first load is restarted, not waited for to the deadline command after command. That still leaves the load
 * 74 s of the 100 s budget; the longest load measured took 31 s at normal priority (23 s at background, November 17).
 */
let restartReserveNanos: UInt64 = 26_000_000_000
/** How often a waiting request looks at where it stands. */
let sessionPollSeconds = 0.25

/** What a line of testmanagerd's log says about loading accessibility. */
enum LoadEvent: Equatable {
  /** "Beginning AX loading sequence.": it is loading accessibility, for a session request. */
  case began
  /** "Finished loading AX.": accessibility is loaded; the session request it was for is answered next. */
  case finished
}

/** The load event a line of testmanagerd's log reports (any of `log stream`'s styles), or nil. */
func loadEvent(inLogLine line: String) -> LoadEvent? {
  if line.contains("Finished loading AX") { return .finished }
  if line.contains("Beginning AX loading sequence") { return .began }
  return nil
}

/**
 * testmanagerd's load while a session request waits, from its log lines as they come: when it began and when it
 * finished (uptime ns). A load that finished before the log was listening is not seen: then testmanagerd has nothing
 * to load, and answers in about a second.
 */
final class LoadLog: @unchecked Sendable {
  private let lock = NSLock()
  private var began: UInt64?
  private var finished: UInt64?
  /** A line of the log, at `now`. */
  func note(_ line: String, at now: UInt64 = DispatchTime.now().uptimeNanoseconds) {
    guard let event = loadEvent(inLogLine: line) else { return }
    lock.lock(); defer { lock.unlock() }
    switch event {
    case .began: began = began ?? now
    case .finished: finished = finished ?? now
    }
  }
  /** When the load finished (nil: not yet). */
  var loadedAt: UInt64? { lock.lock(); defer { lock.unlock() }; return finished }
  /** Whether testmanagerd is loading accessibility: it began, and has not finished. */
  var loading: Bool { lock.lock(); defer { lock.unlock() }; return began != nil && finished == nil }
}

/** Where a session request that has not been answered yet stands. */
enum SessionWait: Equatable {
  /** Still waited for: within the first timeout, within it of the load's end, or while testmanagerd is loading. */
  case waiting
  /**
   * testmanagerd's log said the load finished and the first timeout has passed since: it has nothing left to do and
   * does not answer, a phone that refuses sessions (its daemons are restarted).
   */
  case refused
  /**
   * The first timeout has passed and nothing is loading accessibility: no testmanagerd runs, or its log shows no load
   * under way (one that has nothing to load answers within the first timeout).
   */
  case nothingLoading
  /** Still loading at `loadUntil`: a first request gives up with the time for a restart and a second request left. */
  case loadTooLong
  /** testmanagerd's own 120 s from the request, or the first read's deadline. */
  case outOfTime
}

/**
 * The state of a request at `now` (uptime ns): sent at `requestedAt`; `loadedAt` when testmanagerd's log said the load
 * finished (nil: not yet); `loading`, whether it says one is under way; whether a testmanagerd runs in the phone;
 * `timeout`, how long a testmanagerd with accessibility loaded may take to answer; `loadUntil`, when a request still
 * waiting for the load stops (loadWaitEnd).
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
