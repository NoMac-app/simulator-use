// Checks SessionWait.swift: built with it alone (swiftc SessionWait.swift test/session/main.swift).
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

let s: UInt64 = 1_000_000_000
let timeout = 12 * s, request = 100 * s, deadline = request + 100 * s
func at(_ seconds: UInt64, loaded: UInt64? = nil, loading: Bool = true, daemon: Bool = true, deadline d: UInt64 = deadline, loadUntil: UInt64? = nil) -> SessionWait {
  sessionWait(now: request + seconds * s, requestedAt: request, loadedAt: loaded.map { request + $0 * s }, loading: loading, daemonRunning: daemon, timeout: timeout, deadline: d, loadUntil: loadUntil)
}

// A load testmanagerd's log says finished: nothing left to load, so no answer in the first timeout after it is a
// refusal, whatever testmanagerd it met (November 16, 2026: one 5 s old after an earlier restart, waited for by its
// age, cost 120 s a command).
check(at(5, loaded: 0) == .waiting, "within the first timeout of a loaded phone")
check(at(12, loaded: 0) == .refused, "a loaded phone whose testmanagerd is silent for the first timeout refuses")
check(at(13, loaded: 0, daemon: false) == .refused, "refused whether or not a testmanagerd runs")

// Right after a boot (November 16: 8 s to start, 16.6 s to load, answered at 26.3 s): testmanagerd's log says it is
// loading.
check(at(12) == .waiting, "accessibility still loading at the first timeout: waited for")
check(at(26) == .waiting, "still loading at 26 s with testmanagerd running")
check(at(30, daemon: false) == .nothingLoading, "not loaded, past the first timeout, no testmanagerd: nothing is loading it")
check(at(5, daemon: false) == .waiting, "before the first timeout testmanagerd may not have started yet")
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
starting.note(launchedLine, at: 10 * s)
check(starting.loading && starting.loadedAt == nil, "launched for the request: loading")
check(sessionWait(now: request + 20 * s, requestedAt: request, loadedAt: nil, loading: starting.loading, daemonRunning: true, timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true)) == .waiting,
      "a testmanagerd launched for the request, silent at 20 s: still waited for")
check(sessionWait(now: request + 13 * s, requestedAt: request, loadedAt: nil, loading: LoadLog().loading, daemonRunning: true, timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true)) == .nothingLoading,
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
check(at(13, loading: false) == .nothingLoading, "no load heard past the first timeout: given up (restart), even with testmanagerd running")

// November 17, 2026, a phone booted at background priority beside a live one: the load began 10 s after the request
// and ended at 33 s; testmanagerd answered 2 s later. Waited for throughout, never restarted mid-load.
func throttled(_ t: UInt64) -> SessionWait {
  sessionWait(now: request + t * s, requestedAt: request, loadedAt: t >= 33 ? request + 33 * s : nil, loading: t >= 10 && t < 33,
              daemonRunning: true, timeout: timeout, deadline: deadline, loadUntil: loadWaitEnd(deadline: deadline, restartMayFollow: true))
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
  end = sessionWait(now: request + waited, requestedAt: request, loadedAt: nil, loading: true, daemonRunning: true, timeout: timeout, deadline: deadline, loadUntil: firstUntil)
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
check(sessionWait(now: deadline - 29 * s, requestedAt: deadline - 30 * s, loadedAt: nil, loading: false, daemonRunning: false, timeout: timeout, deadline: deadline, loadUntil: firstUntil) == .waiting,
      "a late request within its first timeout is waited for")

if failures == 0 { print("all checks passed") } else { print("\(failures) failed"); exit(1) }
