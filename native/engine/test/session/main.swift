// Checks SessionWait.swift: built with it alone (swiftc SessionWait.swift test/session/main.swift).
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

let s: UInt64 = 1_000_000_000
let timeout = 12 * s, request = 100 * s, deadline = request + 100 * s
func at(_ seconds: UInt64, loaded: UInt64? = nil, loading: Bool = true, daemon: Daemon = .running, deadline d: UInt64 = deadline, loadUntil: UInt64? = nil) -> SessionWait {
  sessionWait(now: request + seconds * s, requestedAt: request, loadedAt: loaded.map { request + $0 * s }, loading: loading, daemon: daemon, timeout: timeout, deadline: d, loadUntil: loadUntil)
}

// A load testmanagerd's log says finished: nothing left to load, so no answer in the first timeout after it is a
// refusal, whatever testmanagerd it met (November 16, 2026: one 5 s old after an earlier restart, waited for by its
// age, cost 120 s a command).
check(at(5, loaded: 0) == .waiting, "within the first timeout of a loaded phone")
check(at(12, loaded: 0) == .refused, "a loaded phone whose testmanagerd is silent for the first timeout refuses")
check(at(13, loaded: 0, daemon: .none) == .refused, "refused whether or not a testmanagerd runs")

// Right after a boot (November 16: 8 s to start, 16.6 s to load, answered at 26.3 s): testmanagerd's log says it is
// loading.
check(at(12) == .waiting, "accessibility still loading at the first timeout: waited for")
check(at(26) == .waiting, "still loading at 26 s with testmanagerd running")
check(at(30, loading: false, daemon: .none) == .waiting, "no testmanagerd yet past the first timeout: the phone's launchd is starting one for the request")
check(at(5, daemon: .none) == .waiting, "before the first timeout testmanagerd may not have started yet")
// Once the load is seen, the answer has the first timeout from then (it came 0.8 s after the load, measured).
check(at(30, loaded: 25) == .waiting, "loaded at 25 s: still waited for at 30 s")
check(at(37, loaded: 25) == .refused, "loaded at 25 s and silent until 37 s: refused")

// Never past testmanagerd's own 120 s from the request, nor the first read's deadline.
check(at(99) == .waiting, "loading, before the deadline")
check(at(100) == .outOfTime, "the deadline")
check(at(119, deadline: request + 300 * s) == .waiting, "loading, before testmanagerd's 120 s")
check(at(120, deadline: request + 300 * s) == .outOfTime, "testmanagerd's own 120 s")
check(at(100, loaded: 95) == .outOfTime, "loaded late: still never past the deadline")

check(timeForRestart(secondsLeft: 60), "time left for a restart and a second request")
check(!timeForRestart(secondsLeft: 20), "no restart without the time for a second request")

// The signal: testmanagerd's own log lines (compact style, from the throttled phone of November 17, 2026), never a read.
let began = "2026-11-17 13:58:28.257 Df testmanagerd[33241:8e9673] [com.apple.dt.xctest:Default] Beginning AX loading sequence."
let finished = "2026-11-17 13:58:51.137 Df testmanagerd[33241:8e9673] [com.apple.dt.xctest:Default] Finished loading AX."
check(loadEvent(inLogLine: began) == .began, "\"Beginning AX loading sequence.\" is the load beginning")
check(loadEvent(inLogLine: finished) == .finished, "\"Finished loading AX.\" is the load done")
check(loadEvent(inLogLine: "2026-11-17 13:58:25.554 Df testmanagerd[33241:8e9673] [com.apple.dt.xctest:Default] Received request to load Accessibility") == nil,
      "a request to load is not a load (testmanagerd logs it for every session, loaded or not)")
check(loadEvent(inLogLine: "Filtering the log data using \"process == \"testmanagerd\"\"") == nil, "the stream's own first line says nothing")
let launchedLine = "2026-11-17 16:37:55.488 Df testmanagerd[48050:aba384] [com.apple.dt.xctest:Default] Launched testmanagerd from /var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.2.8117.0/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework/testmanagerd"
check(loadEvent(inLogLine: launchedLine) == .launched, "\"Launched testmanagerd from\" is one started for the request")
// One started for the request is waited for while it starts (November 17, 2026, a Session Mac: launched at 10 to 12 s,
// its load later; restarted at 12 s, the first read waited 13 s more); one that was there before and stays silent is not.
let starting = LoadLog()
starting.note(launchedLine, at: request + 10 * s)
check(!starting.loading && starting.loadedAt == nil, "a launch is not a load")
check(starting.launchedAt == request + 10 * s, "the launch is kept with its time, for when the kernel's start time cannot be read")
check(sessionWait(now: request + 20 * s, requestedAt: request, loadedAt: nil, loading: starting.loading, daemon: .started(at: starting.launchedAt!), timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true)) == .waiting,
      "a testmanagerd launched for the request (the log's time), silent at 20 s: still within its first timeout")
check(sessionWait(now: request + 23 * s, requestedAt: request, loadedAt: nil, loading: starting.loading, daemon: .started(at: starting.launchedAt!), timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true)) == .nothingLoading,
      "launched at 10 s and silent, no load, at 23 s: nothing loading")
let snap = LoadLog(); snap.note(began, at: 5 * s); snap.note(finished, at: 9 * s)
let read = snap.snapshot
check(read.loadedAt == 9 * s && !read.loading && read.launchedAt == nil, "one snapshot: loaded, no longer loading")
check(sessionWait(now: request + 13 * s, requestedAt: request, loadedAt: nil, loading: LoadLog().loading, daemon: .running, timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true)) == .nothingLoading,
      "a testmanagerd that was there before (no launch, no load) and silent at 13 s: refused, restarted")
let loadLog = LoadLog()
check(!loadLog.loading && loadLog.loadedAt == nil, "nothing heard: neither loading nor loaded")
loadLog.note(began, at: 10 * s)
check(loadLog.loading && loadLog.loadedAt == nil, "began: loading")
loadLog.note(finished, at: 33 * s)
check(!loadLog.loading && loadLog.loadedAt == 33 * s, "finished: loaded, at the time it was heard")
loadLog.note(finished, at: 40 * s)
check(loadLog.loadedAt == 33 * s, "a later line keeps the first finish")
check(at(5, loading: false) == .waiting, "no load heard yet, within the first timeout: waited for")
check(at(13, loading: false) == .nothingLoading, "no load heard past the first timeout from a testmanagerd that was there: given up (restart)")

// November 17, 2026, a phone booted at background priority beside a live one: the load began 10 s after the request
// and ended at 33 s; testmanagerd answered 2 s later. Waited for throughout, never restarted mid-load.
func throttled(_ t: UInt64) -> SessionWait {
  sessionWait(now: request + t * s, requestedAt: request, loadedAt: t >= 33 ? request + 33 * s : nil, loading: t >= 10 && t < 33,
              daemon: .running, timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true))
}
check((0...44).allSatisfy { throttled(UInt64($0)) == .waiting }, "the throttled load is waited for from the request to 12 s after its end")
check(throttled(45) == .refused, "no answer 12 s after the load: refused")

// A first request stops waiting for a load restartReserveNanos before the deadline, so a testmanagerd stuck in its
// first load (it began and never finished) is restarted in time, not waited for to the deadline command after
// command. Stepped as the engine's loop does.
let firstUntil = loadWaitEnd(deadline: deadline, restartMayFollow: true)
let poll = UInt64(sessionPollSeconds * 1e9)
var waited: UInt64 = 0, end = SessionWait.waiting
while end == .waiting && waited < 200 * s {
  waited += poll
  end = sessionWait(now: request + waited, requestedAt: request, loadedAt: nil, loading: true, daemon: .running, timeout: timeout, deadline: deadline, loadUntil: firstUntil)
}
let left = Double(deadline - (request + waited)) / 1e9 - sessionPollSeconds
check(end == .loadTooLong, "a load not done before the restart's reserve is given up: \(end) after \(Double(waited) / 1e9) s")
check(waited >= 74 * s, "the load still gets 74 s of a 100 s budget: \(Double(waited) / 1e9) s")
check(timeForRestart(secondsLeft: left), "a restart always fits after the give-up, one poll late: \(left) s left")
// The second request (after the restart) has nothing after it: it waits for the load to the deadline.
check(loadWaitEnd(deadline: deadline, restartMayFollow: false) == nil, "a second request keeps no reserve")
check(at(99, loadUntil: nil) == .waiting, "a second request waits for the load to the deadline")
// A load finished before the cut has the first timeout for its answer, as any loaded phone.
check(at(80, loaded: 73, loadUntil: firstUntil) == .waiting, "loaded at 73 s: its answer is waited for past the cut")
// A request sent late (a long turn) is not given up before testmanagerd has had its first timeout.
check(sessionWait(now: deadline - 29 * s, requestedAt: deadline - 30 * s, loadedAt: nil, loading: false, daemon: .none, timeout: timeout, deadline: deadline, loadUntil: firstUntil) == .waiting,
      "a late request within its first timeout is waited for")

// Which testmanagerd: the kernel's start time of the phone's testmanagerd, never the log's launch line alone. November
// 17, 2026, a phone at background priority beside a live one: the request at 0 s, a testmanagerd started for it at
// 13 s, its "Launched" line not yet in the log at 14 s; taken for one that was there, it was restarted, and the next took
// 15 s to start: the first read waited 25 s more.
let launchedAt13 = Daemon.started(at: request + 13 * s)
check(at(14, loading: false, daemon: launchedAt13, loadUntil: firstUntil) == .waiting, "started 13 s after the request, for it, no log line yet at 14 s: waited for")
check(at(24, loading: false, daemon: launchedAt13, loadUntil: firstUntil) == .waiting, "still within the first timeout from its own start")
check(at(25, loading: false, daemon: launchedAt13, loadUntil: firstUntil) == .nothingLoading, "silent and no load 12 s after its own start: nothing loading, restarted")
check(at(30, loading: true, daemon: launchedAt13, loadUntil: firstUntil) == .waiting, "started for the request and loading: waited for")
check(at(74, loading: true, daemon: launchedAt13, loadUntil: firstUntil) == .loadTooLong, "still loading at the restart's reserve: given up in time for a restart")
// One that was there before the request (started before it) is the phone's own, refusing when silent.
check(at(13, loading: false, daemon: .started(at: request - 5 * s), loadUntil: firstUntil) == .nothingLoading, "started before the request, silent at 13 s: refused, restarted")
check(at(11, loading: false, daemon: .started(at: request - 5 * s), loadUntil: firstUntil) == .waiting, "started before the request: within the first timeout, waited for")
// None yet: the phone's launchd starts one for the request; waited for up to the restart's reserve (a restart stops
// nothing then), and on a second request to the deadline.
check(at(40, loading: false, daemon: .none, loadUntil: firstUntil) == .waiting, "no testmanagerd yet at 40 s: launchd is starting one, waited for")
check(at(74, loading: false, daemon: .none, loadUntil: firstUntil) == .loadTooLong, "still none at the restart's reserve: given up in time for a restart")
check(at(99, loading: false, daemon: .none, loadUntil: nil) == .waiting, "a second request waits for one to start to the deadline")
check(at(100, loading: false, daemon: .none, loadUntil: nil) == .outOfTime, "the deadline")
// The whole throttled first request, stepped: started 13 s after the request, its load from 16 s to 40 s, answered at
// 41 s; waited for throughout, never restarted.
func throttledStart(_ t: UInt64) -> SessionWait {
  sessionWait(now: request + t * s, requestedAt: request, loadedAt: t >= 40 ? request + 40 * s : nil, loading: t >= 16 && t < 40,
              daemon: t >= 13 ? .started(at: request + 13 * s) : .none, timeout: timeout, deadline: deadline, loadUntil: firstUntil)
}
check((0...51).allSatisfy { throttledStart(UInt64($0)) == .waiting }, "a testmanagerd started late for the request is waited for from the request to 12 s after its load")
check(throttledStart(52) == .refused, "no answer 12 s after the load: refused")

// The phone held at background priority (RunClock): its silence is not counted, its budgets are.
let held = RunClock(at: request)
for t in 1...60 { held.tick(at: request + UInt64(t) * s, clamped: t <= 50) }
check(held.ran(since: request) == 10 * s, "60 s of which 50 held: 10 s run")
check(held.ran(since: request + 55 * s) == 5 * s, "from 55 s: 5 s run")
check(held.ran(since: request + 55 * s + s / 2) == 4 * s + s / 2, "from within a tick that ran: its part after")
check(held.ran(since: request + 20 * s) == 10 * s, "from within the hold: the run after it")
check(held.ran(since: request - 5 * s) == 10 * s, "from before the first tick: all the run")
check(held.ran(since: request + 70 * s) == 0, "from after the last tick: none")
check(held.clampedNanos == 50 * s, "the time held, for the log")
/** A request's clock ticked every poll from the request to `now`, the phone held until `until`. */
func clock(heldUntil until: UInt64, to now: UInt64) -> RunClock {
  let c = RunClock(at: request); var t = request
  while t < request + now * s { t += poll; c.tick(at: t, clamped: t <= request + until * s) }
  return c
}
func heldWait(_ now: UInt64, loadedAt: UInt64? = nil, loading: Bool = false, daemon: Daemon, heldUntil: UInt64 = 50) -> SessionWait {
  sessionWait(now: request + now * s, requestedAt: request, loadedAt: loadedAt.map { request + $0 * s }, loading: loading, daemon: daemon,
              timeout: timeout, deadline: deadline, loadUntil: firstUntil, ran: clock(heldUntil: heldUntil, to: now).ran(since:))
}
// November 17, 2026, m9, a phone held until about 50 s: a testmanagerd started 5 s after the request logged no load by
// 17 s (restarted then), and another answered more than 12 s after its load finished at 36 s (restarted at 53 s).
check(heldWait(17, daemon: .started(at: request + 5 * s)) == .waiting, "held: a silent testmanagerd started for the request is not refused at 17 s")
check(heldWait(61, daemon: .started(at: request + 5 * s)) == .waiting, "11 s after the hold: still within the first timeout of run")
check(heldWait(63, daemon: .started(at: request + 5 * s)) == .nothingLoading, "13 s of run after the hold, still silent: nothing loading")
check(heldWait(53, loadedAt: 36, daemon: .running) == .waiting, "held: no answer 17 s after the load, 3 s of them run: waited for")
check(heldWait(63, loadedAt: 36, daemon: .running) == .refused, "13 s of run after the load and no answer: refused")
check(heldWait(74, loading: true, daemon: .started(at: request + 5 * s)) == .loadTooLong, "the restart's reserve is wall-clock: held or not")
check(heldWait(100, daemon: .running, heldUntil: 200) == .outOfTime, "the deadline is wall-clock: held throughout")
// Held throughout, a first request still keeps its restart's reserve: a testmanagerd that was there, silent, or one
// whose load finished and that does not answer, is given up at loadUntil (74 s), not waited for to the deadline.
check(heldWait(73, daemon: .running, heldUntil: 200) == .waiting, "held throughout, before the restart's reserve: waited for")
check(heldWait(74, daemon: .running, heldUntil: 200) == .nothingLoading, "held throughout, at the restart's reserve: given up, restarted")
check(heldWait(74, loadedAt: 30, daemon: .running, heldUntil: 200) == .refused, "held throughout, loaded at 30 s, no answer at 74 s: refused")
check(sessionWait(now: deadline - 26 * s + s, requestedAt: deadline - 26 * s - s, loadedAt: nil, loading: false, daemon: .running, timeout: timeout, deadline: deadline, loadUntil: firstUntil, ran: { _ in 0 }) == .waiting,
      "a request sent just before the reserve keeps its first timeout of wall-clock time")
// Not held: as before (the clock's run is the wall-clock time).
check(heldWait(13, daemon: .running, heldUntil: 0) == .nothingLoading, "not held: a silent testmanagerd that was there is refused at 12 s")

if failures == 0 { print("all checks passed") } else { print("\(failures) failed"); exit(1) }
