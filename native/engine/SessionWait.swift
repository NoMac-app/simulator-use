// How long the engine waits for an automation session that has not answered, decided without any framework so that
// its test (native/engine/test/session, run by test/engine-session.test.ts) needs neither a Simulator nor AXe.
//
// The signals: testmanagerd's own account of loading accessibility, from the phone's log while the request waits
// (LoadLog, below): "Beginning AX loading sequence." as its load starts, "Finished loading AX." as it ends, and it
// answers the session request about a second after that (iOS 26.5's and 27.2's testmanagerd log the same lines); and
// when the phone's testmanagerd process started, from the kernel. The phone's launchd starts testmanagerd on demand,
// for the request: none yet, or one started since the request, is one starting for it, and the first timeout counts
// from its start; one that was there before the request and stays silent is a phone that refuses sessions. Never the
// log's "Launched testmanagerd" line alone: on a phone booted at background priority it came after the first timeout
// for a testmanagerd started before it, which was restarted as refusing and cost the first read 25 s (November 17,
// 2026: launched 13 s after the request, restarted at 14 s; the next one took 15 s to start).
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
 * log. A first request stops waiting for testmanagerd (to start, or to load accessibility) that long before the
 * deadline, so a testmanagerd stuck in its first load is restarted, not waited for to the deadline command after
 * command. That still leaves the load 74 s of the 100 s budget; the longest load measured took 31 s at normal priority
 * (23 s at background, November 17).
 */
let restartReserveNanos: UInt64 = 26_000_000_000
/** How often a waiting request looks at where it stands. */
let sessionPollSeconds = 0.25

/** What a line of testmanagerd's log says about loading accessibility. */
enum LoadEvent: Equatable {
  /**
   * "Launched testmanagerd from …": a testmanagerd started after the request went out, so for it (7 to 17 s after a
   * boot on a busy Mac). The kernel's start time says so first (daemonStart, main.swift); this line counts where that cannot be read.
   */
  case launched
  /** "Beginning AX loading sequence.": it is loading accessibility, for a session request. */
  case began
  /** "Finished loading AX.": accessibility is loaded; the session request it was for is answered next. */
  case finished
}

/** The load event a line of testmanagerd's log reports (any of `log stream`'s styles), or nil. */
func loadEvent(inLogLine line: String) -> LoadEvent? {
  if line.contains("Finished loading AX") { return .finished }
  if line.contains("Beginning AX loading sequence") { return .began }
  if line.contains("Launched testmanagerd") { return .launched }
  return nil
}

/**
 * testmanagerd's load while a session request waits, from its log lines as they come: when it began and when it
 * finished (uptime ns). A load that finished before the log was listening is not seen: then testmanagerd has nothing
 * to load, and answers in about a second.
 */
final class LoadLog: @unchecked Sendable {
  private let lock = NSLock()
  private var launched: UInt64?
  private var began: UInt64?
  private var finished: UInt64?
  /** A line of the log, at `now`. */
  func note(_ line: String, at now: UInt64 = DispatchTime.now().uptimeNanoseconds) {
    guard let event = loadEvent(inLogLine: line) else { return }
    lock.lock(); defer { lock.unlock() }
    switch event {
    case .launched: launched = launched ?? now
    case .began: began = began ?? now
    case .finished: finished = finished ?? now
    }
  }
  private var listened: UInt64?
  /** The stream says it listens (its first line), at `now`. */
  func listening(at now: UInt64 = DispatchTime.now().uptimeNanoseconds) { lock.lock(); defer { lock.unlock() }; listened = listened ?? now }
  /** When the stream began listening (nil: not yet). */
  var listeningAt: UInt64? { lock.lock(); defer { lock.unlock() }; return listened }
  /** When the log said a testmanagerd launched (nil: not heard). */
  var launchedAt: UInt64? { lock.lock(); defer { lock.unlock() }; return launched }
  /** When the load finished (nil: not yet). */
  var loadedAt: UInt64? { lock.lock(); defer { lock.unlock() }; return finished }
  /**
   * Whether testmanagerd is loading accessibility, or starting to for this request: it began, or it was launched since
   * the request; and it has not finished.
   */
  var loading: Bool { lock.lock(); defer { lock.unlock() }; return (began != nil || launched != nil) && finished == nil }
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
   * Nothing is loading accessibility: a testmanagerd that was there before the request shows no load under way past
   * the first timeout, or one started for the request none past the first timeout from its start (one that has nothing
   * to load answers within the first timeout).
   */
  case nothingLoading
  /** Still loading at `loadUntil`: a first request gives up with the time for a restart and a second request left. */
  case loadTooLong
  /** testmanagerd's own 120 s from the request, or the first read's deadline. */
  case outOfTime
}

/**
 * How long the phone has had the CPU, as a request waits: its host may hold all its processes at background priority
 * (NoMac's phone hosts do, for a phone prepared beside a live one), and a starved phone's silence says nothing about
 * whether it refuses. On a phone so held (November 17, 2026), a testmanagerd started for the request logged no load in
 * the 12 s after its start, and another answered 12 to 17 s after its load finished: both were restarted as refusing,
 * which switched accessibility off and on again in the phone and cost its reads 25 s more. So the silence the first
 * timeout measures is time the phone ran unclamped; the request's budgets (the deadline, testmanagerd's 120 s, the
 * restart's reserve) stay wall-clock time. Ticked by the request's wait loop with whether the phone was clamped.
 */
final class RunClock {
  private var marks: [(at: UInt64, ran: UInt64)]
  private var total: UInt64 = 0
  private var last: UInt64
  /** Time the phone was clamped, for the request's log. */
  private(set) var clampedNanos: UInt64 = 0
  init(at now: UInt64) { last = now; marks = [(now, 0)] }
  /** The time since the last tick, counted as run unless the phone was clamped. */
  func tick(at now: UInt64, clamped: Bool) {
    guard now > last else { return }
    if clamped { clampedNanos += now - last } else { total += now - last }
    last = now
    marks.append((now, total))
  }
  /** The phone's unclamped time from `t` to the last tick (from the first tick for a `t` before it). */
  func ran(since t: UInt64) -> UInt64 { total - ran(upTo: t) }
  /** The phone's unclamped time from the first tick to `t`. */
  private func ran(upTo t: UInt64) -> UInt64 {
    guard let i = marks.lastIndex(where: { $0.at <= t }) else { return 0 }
    // `t` within a tick that ran counts that tick's part before it; within a clamped one, or past the last tick, none.
    guard i + 1 < marks.count, marks[i + 1].ran > marks[i].ran else { return marks[i].ran }
    return marks[i].ran + (t - marks[i].at)
  }
}

/** The phone's testmanagerd as a request waits. */
enum Daemon: Equatable {
  /** None runs yet: the phone's launchd starts one for the request (15 s after it on a phone at background priority). */
  case none
  /** One runs, started at that time (uptime ns; from the kernel, or when its log said it launched). */
  case started(at: UInt64)
  /** One runs, and when it started is not known: taken as the one that was there before the request. */
  case running
}

/**
 * The state of a request at `now` (uptime ns): sent at `requestedAt`; `loadedAt` when testmanagerd's log said the load
 * finished (nil: not yet); `loading`, whether it says one is under way; the phone's testmanagerd (`daemon`); `timeout`,
 * how long a testmanagerd may stay silent with nothing to load (from the request, or from its own start when it
 * started for the request), in time the phone ran (`ran`: its unclamped time from a moment to now, RunClock; all of it
 * when nil); `loadUntil`, when a request still waiting for testmanagerd stops (loadWaitEnd).
 */
func sessionWait(now: UInt64, requestedAt: UInt64, loadedAt: UInt64?, loading: Bool, daemon: Daemon, timeout: UInt64, deadline: UInt64, loadUntil: UInt64? = nil, ran: ((UInt64) -> UInt64)? = nil) -> SessionWait {
  let ranSince = ran ?? { now > $0 ? now - $0 : 0 }
  if now >= min(deadline, requestedAt + testmanagerdLoadLimitNanos) { return .outOfTime }
  if let loadedAt { return ranSince(max(loadedAt, requestedAt)) < timeout ? .waiting : .refused }
  // Since when testmanagerd has had the request: from the request, or from the start of one started for it; none yet,
  // it has not had it at all.
  var heardSince: UInt64? = requestedAt
  switch daemon {
  case .none: heardSince = nil
  case .started(let at): heardSince = max(at, requestedAt)
  case .running: break
  }
  let starting = heardSince != requestedAt
  if loading || starting, let loadUntil, now >= loadUntil { return .loadTooLong }
  if loading { return .waiting }
  guard let heardSince else { return .waiting }
  return ranSince(heardSince) < timeout ? .waiting : .nothingLoading
}

/** When a request stops waiting for the load: a first one (a restart may follow) leaves restartReserveNanos. */
func loadWaitEnd(deadline: UInt64, restartMayFollow: Bool) -> UInt64? {
  restartMayFollow ? deadline - min(deadline, restartReserveNanos) : nil
}

/** Whether the first read still has time for a restart of the phone's test daemons and a second request. */
func timeForRestart(secondsLeft: Double) -> Bool { secondsLeft > 25 }
