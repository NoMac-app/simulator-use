// Checks SessionWait.swift: built with it alone (swiftc SessionWait.swift test/session/main.swift).
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

let s: UInt64 = 1_000_000_000
let timeout = 12 * s, request = 100 * s, deadline = request + 100 * s
func at(_ seconds: UInt64, loaded: UInt64? = nil, daemon: Bool = true, deadline d: UInt64 = deadline) -> SessionWait {
  sessionWait(now: request + seconds * s, requestedAt: request, loadedAt: loaded.map { request + $0 * s }, daemonRunning: daemon, timeout: timeout, deadline: d)
}

// Accessibility loaded before the request (a read without a session answered at once): nothing to load, so no answer
// in the first timeout is a refusal, whatever testmanagerd it met (November 16, 2026: one 5 s old after an earlier
// restart, waited for by its age, cost 120 s a command).
check(at(5, loaded: 0) == .waiting, "within the first timeout of a loaded phone")
check(at(12, loaded: 0) == .refused, "a loaded phone whose testmanagerd is silent for the first timeout refuses")
check(at(13, loaded: 0, daemon: false) == .refused, "refused whether or not a testmanagerd runs")

// Right after a boot (November 16: 8 s to start, 16.6 s to load, answered at 26.3 s): no read answers while it loads.
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

if failures == 0 { print("all checks passed") } else { print("\(failures) failed"); exit(1) }
