// Checks SessionWait.swift: built with it alone (swiftc SessionWait.swift test/session/main.swift).
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

let s: UInt64 = 1_000_000_000
let timeout = 12 * s, request = 100 * s, deadline = request + 100 * s
func at(_ seconds: UInt64, loaded: UInt64? = nil, loading: Bool = true, daemon: Bool = true, deadline d: UInt64 = deadline, loadUntil: UInt64? = nil) -> SessionWait {
  sessionWait(now: request + seconds * s, requestedAt: request, loadedAt: loaded.map { request + $0 * s }, loading: loading, daemonRunning: daemon, timeout: timeout, deadline: d, loadUntil: loadUntil)
}

// Accessibility loaded before the request (a read without a session answered at once): nothing to load, so no answer
// in the first timeout is a refusal, whatever testmanagerd it met (November 16, 2026: one 5 s old after an earlier
// restart, waited for by its age, cost 120 s a command).
check(at(5, loaded: 0) == .waiting, "within the first timeout of a loaded phone")
check(at(12, loaded: 0) == .refused, "a loaded phone whose testmanagerd is silent for the first timeout refuses")
check(at(13, loaded: 0, daemon: false) == .refused, "refused whether or not a testmanagerd runs")

// Right after a boot (November 16: 8 s to start, 16.6 s to load, answered at 26.3 s): reads fail for want of a
// translation object while it loads.
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

// Only the not-loaded answer is evidence of loading: any other read error, or a read that hangs, says nothing.
check(accessibilityRead(error: nil) == .loaded, "a read that answers: loaded")
check(accessibilityRead(error: "Error Domain=com.facebook.FBControlCore Code=0 \"No translation object returned for simulator\"") == .notLoaded, "no translation object: not loaded")
check(accessibilityRead(error: "The operation couldn’t be completed. (Mach error -308 - (ipc/mig) server died)") == .unknown, "any other error: unknown")
check(at(5, loading: false) == .waiting, "no evidence yet, within the first timeout: waited for")
check(at(13, loading: false) == .nothingLoading, "no evidence of loading past the first timeout: given up (restart), even with testmanagerd running")

// A first request stops waiting for a load restartReserveNanos before the deadline, so a testmanagerd stuck before its
// first load (every read finds no translation object, testmanagerd runs) is restarted in time, not waited for to the
// deadline command after command. Stepped as the engine's loop does.
let firstUntil = loadWaitEnd(deadline: deadline, restartMayFollow: true)
let poll = UInt64(sessionPollSeconds * 1e9)
var waited: UInt64 = 0, end = SessionWait.waiting
while end == .waiting && waited < 200 * s {
  waited += poll
  end = sessionWait(now: request + waited, requestedAt: request, loadedAt: nil, loading: true, daemonRunning: true, timeout: timeout, deadline: deadline, loadUntil: firstUntil)
}
let left = Double(deadline - (request + waited)) / 1e9 - sessionPollSeconds - watchStopSeconds
check(end == .loadTooLong, "a load not done before the restart's reserve is given up: \(end) after \(Double(waited) / 1e9) s")
check(waited >= 74 * s, "the load still gets 74 s of a 100 s budget: \(Double(waited) / 1e9) s")
check(timeForRestart(secondsLeft: left), "a restart always fits after the give-up, one poll late and with the watch's stop: \(left) s left")
// The second request (after the restart) has nothing after it: it waits for the load to the deadline.
check(loadWaitEnd(deadline: deadline, restartMayFollow: false) == nil, "a second request keeps no reserve")
check(at(99, loadUntil: nil) == .waiting, "a second request waits for the load to the deadline")
// A load seen before the cut has the first timeout for its answer, as any loaded phone.
check(at(80, loaded: 73, loadUntil: firstUntil) == .waiting, "loaded at 73 s: its answer is waited for past the cut")
// A request sent late (a long turn) is not given up before its first read has said anything.
check(sessionWait(now: deadline - 29 * s, requestedAt: deadline - 30 * s, loadedAt: nil, loading: false, daemonRunning: false, timeout: timeout, deadline: deadline, loadUntil: firstUntil) == .waiting,
      "a late request with no read back yet is waited for")

// The watch: reads a little apart until one answers; a read past its limit is no evidence and is never waited for.
final class Reads: @unchecked Sendable {
  private let lock = NSLock()
  private var answers: [AccessibilityRead?]
  private(set) var count = 0
  /** nil: a read that hangs (and ignores cancellation, as a stuck call into the phone does). */
  init(_ answers: [AccessibilityRead?]) { self.answers = answers }
  private func take() -> AccessibilityRead? {
    lock.lock(); defer { lock.unlock() }
    count += 1
    return answers.isEmpty ? .unknown : answers.removeFirst()
  }
  func next() async -> AccessibilityRead {
    if let answer = take() { return answer }
    return await withCheckedContinuation { c in DispatchQueue.global().asyncAfter(deadline: .now() + 30) { c.resume(returning: .unknown) } }
  }
}
func seconds(since t: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1e9 }

let loads = Reads([.notLoaded, .notLoaded, .loaded])
let loadWatch = AccessibilityWatch(readLimit: 1, every: 0.05) { await loads.next() }
Thread.sleep(forTimeInterval: 0.5)
check(loadWatch.loadedAt != nil && loads.count == 3, "reads until one answers, then stops: \(loads.count) reads")
loadWatch.stop(until: .now() + 5)

let other = Reads([.unknown, .unknown, .unknown])
let otherWatch = AccessibilityWatch(readLimit: 1, every: 0.05) { await other.next() }
Thread.sleep(forTimeInterval: 0.2)
check(!otherWatch.loading && otherWatch.loadedAt == nil, "reads failing another way: neither loaded nor loading")
otherWatch.stop(until: .now() + 5)

let hung = Reads([.notLoaded, nil])
let hungWatch = AccessibilityWatch(readLimit: 0.3, every: 0.05) { await hung.next() }
Thread.sleep(forTimeInterval: 0.15)
check(hungWatch.loading, "the last read found no translation object and the one in flight is within its limit: loading")
Thread.sleep(forTimeInterval: 0.4)
check(!hungWatch.loading, "the read in flight is past its limit: no longer evidence of loading")
var stopped = DispatchTime.now()
hungWatch.stop(until: .now() + 10)
check(seconds(since: stopped) < 0.1, "a read past its limit is not waited for by stop: \(seconds(since: stopped)) s")

let stuck = Reads([nil])
let stuckWatch = AccessibilityWatch(readLimit: 0.5, every: 0.05) { await stuck.next() }
Thread.sleep(forTimeInterval: 0.1)
stopped = DispatchTime.now()
stuckWatch.stop(until: .now() + 10)
let stuckWait = seconds(since: stopped)
check(stuckWait > 0.2 && stuckWait < 1, "a hung read is waited for only to its limit, never to the deadline: \(stuckWait) s")
let early = AccessibilityWatch(readLimit: 5, every: 0.05) { await Reads([nil]).next() }
Thread.sleep(forTimeInterval: 0.05)
stopped = DispatchTime.now()
early.stop(until: .now() + watchStopSeconds)
check(seconds(since: stopped) < watchStopSeconds + 0.2, "an unanswered request's stop waits at most watchStopSeconds: \(seconds(since: stopped)) s")

if failures == 0 { print("all checks passed") } else { print("\(failures) failed"); exit(1) }
