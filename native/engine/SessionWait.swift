// How long the engine waits for an automation session that has not answered, decided without any framework so that
// its test (native/engine/test/session, run by test/engine-session.test.ts) needs neither a Simulator nor AXe.

/** What a session request that has not been answered within its first timeout has met in the phone. */
enum UnansweredSession: Equatable {
  /**
   * A testmanagerd this request started (none ran, or another one, when it went out): it loads accessibility in the
   * phone before it answers, and allows itself 120 s for that.
   */
  case loading(pid: Int32)
  /** The testmanagerd that was already there (or none at all): the phone refuses sessions; its daemons are restarted. */
  case refused
}

/** The phone's testmanagerd pid as the request went out and now (0: none). */
func unansweredSession(daemonBefore: Int32, daemonNow: Int32) -> UnansweredSession {
  daemonNow > 0 && daemonNow != daemonBefore ? .loading(pid: daemonNow) : .refused
}

/** testmanagerd's own limit for loading accessibility ("Waiting 120.0s for AX to finish loading"). */
let testmanagerdLoadLimitNanos: UInt64 = 120_000_000_000

/** Until when a loading testmanagerd is waited for: its own limit from the request, never past the deadline (uptime ns). */
func loadingWaitUntil(requestedAt: UInt64, deadline: UInt64) -> UInt64 {
  min(requestedAt + testmanagerdLoadLimitNanos, deadline)
}

/** Whether the first read still has time for a restart of the phone's test daemons and a second request. */
func timeForRestart(secondsLeft: Double) -> Bool { secondsLeft > 25 }
