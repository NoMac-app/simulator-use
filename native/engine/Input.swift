// How taps, keys and buttons reach the phone.
//
// CoreSimulator takes input two ways. The legacy one (Indigo, SimDeviceLegacyHIDClient) sends each event as a message.
// Xcode 27 adds dtuhidd, a daemon in the phone that runs while Device Hub shows the phone: AXe 2.0 drives it over XPC
// and waits for the phone to confirm each event. While dtuhidd runs, AXe's Indigo transport is not to be relied on
// (AXe: it gives keys no text; measured November 16, 2026 with Device Hub showing the phone: AXe 2.0.4's Indigo taps
// were sent and none landed, where dtuhidd's landed 6 of 6), so AXe picks dtuhidd for everything then, and Indigo
// otherwise. The engine makes the same choice, but before every input rather than once at its start (Device Hub opens
// and closes while the engine runs), and keeps its dtuhidd connection open: AXe's own send waits 380 ms after each
// gesture so that a short-lived process does not close the connection before the phone has the events (382 to 395 ms
// a tap, measured), which a kept connection does not need.
import Foundation
@preconcurrency import FBControlCore
@preconcurrency import FBSimulatorControl

/**
 * Which way input goes (--hid, else SIMULATOR_USE_ENGINE_HID; auto when neither says or the value is unknown):
 * - auto: by dtuhidd while it runs in the phone (looked up before every input), else by Indigo.
 * - indigo: always by Indigo. dtuhid: always by dtuhidd (the engine does not start without it).
 */
enum HIDChoice: String { case auto, indigo, dtuhid }
/** AXe opened Indigo, not dtuhidd: dtuhidd stopped since it was looked up. */
struct DtuhiddGone: Error {}

final class PhoneInput: @unchecked Sendable {
  let choice: HIDChoice
  private let simulator: FBSimulator
  private let logger: FBControlCoreLogger
  private var indigo: FBSimulatorHID?
  /** Whether the Indigo connection was made while dtuhidd ran: AXe's Indigo transport then refuses keys for good. */
  private var indigoMadeBesideDtuhidd = false
  private var dtuhid: FBSimulatorHID?
  /** The dtuhidd its connection was opened to: another one (dtuhidd restarted) means the connection is gone. */
  private var dtuhidFor: pid_t = 0
  /** How the request's input went ("indigo", "dtuhid", or both), and how long a dtuhidd connection it opened took. */
  private var route = Set<String>()
  private var dtuhidConnectMs: Int?
  /**
   * Whether any of the request's input may have reached the phone: a piece was handed to a connection. A request that
   * fails after that answers input_sent, so simulator-use never sends the input again another way.
   */
  private(set) var sent = false
  /** A request starts: nothing of it sent yet. */
  func beginRequest() { route = []; dtuhidConnectMs = nil; sent = false }
  /** What the request's inputs went by, for its answer (failed or not). */
  func report() -> [String: Any] {
    var out: [String: Any] = [:]
    if !route.isEmpty { out["via"] = route.sorted().joined(separator: "+") }
    if let dtuhidConnectMs { out["dtuhid_connect_ms"] = dtuhidConnectMs }
    return out
  }

  init(_ simulator: FBSimulator, choice: HIDChoice, logger: FBControlCoreLogger) {
    self.simulator = simulator; self.choice = choice; self.logger = logger
  }

  static let noDtuhidd = "--hid dtuhid: dtuhidd does not run in this phone (it runs while Device Hub shows the phone)"

  static func choiceFromArguments() -> HIDChoice {
    let given = CommandLine.arguments.firstIndex(of: "--hid").flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil }
      ?? ProcessInfo.processInfo.environment["SIMULATOR_USE_ENGINE_HID"]
    return given.flatMap(HIDChoice.init(rawValue:)) ?? .auto
  }

  /** dtuhidd's pid in this phone now (a child of its launchd_sim, where AXe 2.0 looks for it), or 0. */
  func dtuhiddPid() -> pid_t { phoneProcesses.pid(named: "dtuhidd") }

  /** Whether the next input goes by dtuhidd. */
  private func byDtuhid() -> Bool {
    switch choice {
    case .dtuhid: return true
    case .indigo: return false
    case .auto: return dtuhiddPid() > 0
    }
  }

  /** What the choice needs at start: Indigo's connection (immediate), or dtuhidd's for --hid dtuhid. */
  func start() async throws {
    switch choice {
    case .dtuhid:
      do { _ = try await dtuhidConnection() } catch is DtuhiddGone { throw EngineError(message: Self.noDtuhidd) }
    case .indigo:
      _ = try indigoConnection(forKeys: false)
    case .auto:
      // dtuhidd's connection is opened by the first input that needs it: a read needs none.
      if dtuhiddPid() == 0 { _ = try indigoConnection(forKeys: false) }
    }
  }

  /** What the ready line says: the way input goes now, the choice, and whether dtuhidd runs in the phone. */
  func describe() -> [String: Any] {
    ["hid": byDtuhid() ? "dtuhid" : "indigo", "hid_choice": choice.rawValue, "dtuhidd": dtuhiddPid() > 0]
  }

  private func indigoConnection(forKeys: Bool) throws -> FBSimulatorHID {
    // Made while dtuhidd ran, AXe's Indigo transport refuses keys: made again for keys once dtuhidd is gone.
    if let indigo, !(forKeys && indigoMadeBesideDtuhidd && dtuhiddPid() == 0) { return indigo }
    indigo?.disconnect()
    let made = try FBSimulatorHID(for: simulator, transport: .indigo)
    indigoMadeBesideDtuhidd = dtuhiddPid() > 0
    indigo = made
    return made
  }

  /**
   * dtuhidd's connection, opened the first time it is needed (AXe's own open, which waits up to 10 s for the phone to
   * answer on it) and kept while that dtuhidd runs.
   */
  private func dtuhidConnection() async throws -> FBSimulatorHID {
    let running = dtuhiddPid()
    if let dtuhid, running == dtuhidFor { return dtuhid }
    dtuhid?.disconnect(); dtuhid = nil
    let start = Date()
    // FBSimulatorHID.ready opens AXe's default transport, which is dtuhidd's exactly when dtuhidd runs.
    let made = try await FBSimulatorHID.ready(for: simulator)
    guard made.transportType == .dtuhid else {
      made.disconnect()
      throw DtuhiddGone()
    }
    dtuhidConnectMs = Int(Date().timeIntervalSince(start) * 1000)
    dtuhid = made; dtuhidFor = running
    return made
  }

  /** Every piece of an event in order, composites opened. */
  private static func pieces(_ event: FBSimulatorHIDEvent) -> [FBSimulatorHIDEvent] {
    if case let .composite(events) = event { return events.flatMap(pieces) }
    return [event]
  }

  /**
   * The event as it goes to dtuhidd, as AXe 2.0.4 adapts it for that transport (FBSimulatorHIDEvent.event(for:),
   * internal to it): 10 ms after each key, and 50 ms after the last of them.
   */
  static func pacedForDtuhid(_ event: FBSimulatorHIDEvent) -> FBSimulatorHIDEvent {
    var paced: [FBSimulatorHIDEvent] = [], keys = false
    for piece in pieces(event) {
      paced.append(piece)
      if case .keyboard = piece { paced.append(.delay(0.01)); keys = true }
    }
    if keys { paced.append(.delay(0.05)) }
    return .composite(paced)
  }

  func send(_ event: FBSimulatorHIDEvent) async throws {
    if byDtuhid() {
      do { return try await sendDtuhid(event) } catch is DtuhiddGone where choice == .auto {
        // dtuhidd stopped between the look and the connection (Device Hub closed): Indigo, as without it.
      } catch is DtuhiddGone {
        throw EngineError(message: Self.noDtuhidd)
      }
    }
    route.insert("indigo")
    let typing = Self.pieces(event).contains { if case .keyboard = $0 { return true }; return false }
    try await sendPieces(event, on: try indigoConnection(forKeys: typing))
  }

  /**
   * On dtuhidd's kept connection, each piece confirmed by the phone in turn, without AXe's 380 ms wait after the
   * gesture. A failed input is never sent again (part of it may have arrived): the connection is dropped, and the
   * next input opens a new one.
   */
  private func sendDtuhid(_ event: FBSimulatorHIDEvent) async throws {
    let connection = try await dtuhidConnection()
    route.insert("dtuhid")
    do {
      try await sendPieces(Self.pacedForDtuhid(event), on: connection)
    } catch {
      connection.disconnect(); if dtuhid === connection { dtuhid = nil }
      throw error
    }
  }

  /**
   * The event's pieces in order, each sent and acknowledged before the next (sendAsync, as AXe's own send does them
   * for Indigo; AXe's flush after them is nothing on Indigo and the 380 ms wait on dtuhidd), the pauses slept. `sent`
   * turns true as the first piece is handed over.
   */
  private func sendPieces(_ event: FBSimulatorHIDEvent, on connection: FBSimulatorHID) async throws {
    for piece in Self.pieces(event) {
      if case let .delay(seconds) = piece {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        continue
      }
      sent = true
      try await piece.sendAsync(on: connection)
    }
  }
}
