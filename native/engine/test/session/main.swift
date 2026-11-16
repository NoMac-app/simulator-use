// Checks SessionWait.swift: built with it alone (swiftc SessionWait.swift test/session/main.swift).
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

// Right after a boot: no testmanagerd ran; the request started one, still loading accessibility.
check(unansweredSession(daemonBefore: 0, daemonNow: 812) == .loading(pid: 812), "a testmanagerd the request started is waited for")
// After the phone's daemons were restarted, the second request starts a new one.
check(unansweredSession(daemonBefore: 640, daemonNow: 901) == .loading(pid: 901), "a new testmanagerd after a restart is waited for")
// November 16, 2026: after an earlier engine's restart a testmanagerd 5 s old was there as the request went out and
// never answered; waiting for it by its age cost 120 s a command. It is the refusing phone: restart at 12 s.
check(unansweredSession(daemonBefore: 777, daemonNow: 777) == .refused, "a testmanagerd already there that does not answer is a refusal, whatever its age")
check(unansweredSession(daemonBefore: 777, daemonNow: 0) == .refused, "no testmanagerd at all is a refusal")
check(unansweredSession(daemonBefore: 0, daemonNow: 0) == .refused, "no testmanagerd before or after is a refusal")

// The wait for a loading testmanagerd ends at its own 120 s from the request, or at the first read's deadline.
let s: UInt64 = 1_000_000_000
check(loadingWaitUntil(requestedAt: 10 * s, deadline: 300 * s) == 130 * s, "120 s from the request")
check(loadingWaitUntil(requestedAt: 10 * s, deadline: 100 * s) == 100 * s, "never past the deadline")
check(timeForRestart(secondsLeft: 60), "time left for a restart and a second request")
check(!timeForRestart(secondsLeft: 20), "no restart without the time for a second request")

if failures == 0 { print("all checks passed") } else { print("\(failures) failed"); exit(1) }
