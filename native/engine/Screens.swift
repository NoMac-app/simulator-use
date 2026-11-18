// Screens: a phone with more than one screen (the iPhone Duo), followed by every engine of the phone on its own.
//
// A one-screen phone has one screen, its buffer from FBFramebuffer as before; nothing here runs for it but the slot
// that names it. A foldable has two integrated screens (the Duo: 1, the outer, 1398x2034, and 3, the inner,
// 2007x2853), each with its own buffer, and one of them in use. The engine learns all of it from CoreSimulator
// itself, never from another engine: each screen's buffer and its changes through the screen callbacks
// (SimScreen's registerScreenCallbacks, as AXe 2.0's display feed registers them; MIT), and which screen is in use
// and how the guest turns it from the guest's own display report (AXe 2.0's ActivePanelReader), read again whenever a
// screen's properties change, a screen gives a new buffer, or the hinge moves.
import Foundation
import CoreGraphics
import IOSurface
@preconcurrency import CoreSimulator
@preconcurrency import CoreSimDeviceIO
@preconcurrency import FBControlCore
@preconcurrency import FBSimulatorControl

/** One screen of the phone, with what the engine keeps for it while another is in use. */
final class ScreenSlot: @unchecked Sendable {
  let id: UInt32
  var uniqueID: String
  /** main (a one-screen phone), outer or inner (a foldable's smaller and larger screen). */
  var role: String
  var geometry: ScreenGeometry
  /** Its buffer and when it changed. */
  let watcher: DamageWatcher
  /** When its buffer last changed in a way that counts (Settle.swift). */
  let clock = WriteClock()
  // What the engine keeps for the screen in use, put back here when another one is (Settle and the read path).
  var caretZones: [CGRect] = []
  var lastPlacement: (pid: Int, app: CGRect, placement: Placement?, at: Date)? = nil
  var lastWebScan: (seed: UInt32, region: CGRect, elements: [[String: Any]])? = nil
  /** The touch connection aimed at this screen, for its geometry when it was made (a foldable's input). */
  var hid: (geometry: ScreenGeometry, connection: FBSimulatorHID)?
  /** The touch connection being made (and made ready) now, for its geometry. */
  var making: (geometry: ScreenGeometry, task: Task<FBSimulatorHID, Error>)?

  init(id: UInt32, uniqueID: String, role: String, geometry: ScreenGeometry, watcher: DamageWatcher) {
    self.id = id; self.uniqueID = uniqueID; self.role = role; self.geometry = geometry; self.watcher = watcher
  }

  /** The contract's screen: { id, role, width, height, scale, orientation }, width and height the drawn pixels. */
  var json: [String: Any] {
    let drawn = geometry.drawnPixels
    return ["id": Int(id), "role": role, "width": Int(drawn.width), "height": Int(drawn.height), "scale": Double(geometry.scale), "orientation": geometry.orientation]
  }
  /**
   * The screen event a stream engine writes on stderr when the screen in use or the posture changes (the contract):
   * "@nomac " and {"screen":{id, role, width, height, scale, orientation},"posture":...} on one line. Nil when a value
   * is outside the contract's bounds (sides 32 to 8192 whole pixels, scale 1 to 4), which no phone has.
   */
  func eventLine(posture: String?) -> String? { screenEventLine(id: id, role: role, geometry: geometry, posture: posture) }
  /** "inner screen 669x951": how ui_look and the tools name it. */
  var described: String { "\(role) screen \(Int(geometry.points.width))x\(Int(geometry.points.height))" }
}

/** Why an input or a fold was refused: the contract's typed errors. */
struct ScreenError: Error {
  let code: String
  let message: String
}

/**
 * The phone's screens and the one in use. The request loop applies what the resolver found (apply) at the start of
 * each request and checks it before each piece of input it sends (inputAllowed), so a request never sees the screen
 * change under it without saying so; the resolver runs whenever CoreSimulator says something changed.
 */
@MainActor
final class Screens {
  let simulator: FBSimulator
  let foldable: Bool
  private(set) var slots: [ScreenSlot]
  /** The screen the request loop works on now (the engine's globals hold its state). */
  private(set) var applied: ScreenSlot
  /** The screen in use as last read from the phone, and its turn. */
  fileprivate var resolvedID: UInt32
  private var resolvedRotation: Int
  /**
   * The guest's display report could not be read steadily at the last try (a hinge move cut off midway leaves it so
   * until the hinge moves again; AXe 2.0 says the same): the last screen known stays, input is refused.
   */
  private(set) var unsteady = false
  /** Counts what the resolver found that differs from before: a request that saw it change answers screen_changed. */
  private(set) var generation = 0
  /** Something changed that was not read yet (a callback since the last read), or a read is going on. */
  fileprivate(set) var changing = false
  private var dirty = false
  private var resolving = false
  /** The hinge's angle when last read, and the posture it is. */
  private(set) var hingeDegrees: Double?
  var posture: String? { foldable ? hingeDegrees.map(postureName(degrees:)) : nil }
  /** The boot the screens were found in (a fold asks the hinge only for that boot). */
  private(set) var bootIdentity: String?
  /** Called on the main actor after the screen in use (or its turn) changed: the stream restarts on it. */
  var onChange: [(ScreenSlot) -> Void] = []
  /** Called on the main actor when the hinge's posture changed (the stream tells it even on the same screen). */
  var onPosture: [() -> Void] = []
  private var feed: ScreenFeed?
  /** What the resolver read last, for the answers that show it (screens op). */
  private(set) var lastResolve: [String: Any] = [:]

  /** A one-screen phone: its one slot, the engine's buffer as before. */
  init(simulator: FBSimulator, single slot: ScreenSlot) {
    self.simulator = simulator; foldable = false; slots = [slot]; applied = slot
    resolvedID = slot.id; resolvedRotation = slot.geometry.rotation
  }

  private init(simulator: FBSimulator, slots: [ScreenSlot], feed: ScreenFeed) {
    self.simulator = simulator; foldable = true; self.slots = slots; self.feed = feed
    applied = slots[0]; resolvedID = slots[0].id; resolvedRotation = 0
  }

  /**
   * A foldable's screens: each integrated screen the device type declares, its buffer followed through the screen
   * callbacks, and the one in use read from the phone before the engine says it is ready.
   */
  static func foldable(_ simulator: FBSimulator, ids: [UInt32]) async throws -> Screens {
    let displays = try await FBSimulatorDisplayDiscovery.displays(for: simulator, timeout: 5)
    let integrated = displays.filter { ids.contains($0.screenID) }
    guard integrated.count == ids.count, integrated.count >= 2 else { throw EngineError(message: "the phone's screens \(ids) are not all there (found \(displays.map(\.screenID)))") }
    // The larger screen is the inner one (the Duo's 2007x2853 against 1398x2034).
    let largest = integrated.max { $0.nativePixelSize.width * $0.nativePixelSize.height < $1.nativePixelSize.width * $1.nativePixelSize.height }!.screenID
    let slots = integrated.map { d in
      ScreenSlot(id: d.screenID, uniqueID: d.uniqueID ?? "", role: d.screenID == largest ? "inner" : "outer",
                 geometry: ScreenGeometry(native: d.nativePixelSize, scale: CGFloat(d.scale), rotation: 0), watcher: DamageWatcher())
    }
    let feed = try await ScreenFeed.start(simulator, slots: slots)
    let screens = Screens(simulator: simulator, slots: slots, feed: feed)
    // A screen's properties change when the hinge moves (measured: both screens, about 4.8 s after a close): the
    // hinge is read with that read, so a switch the posture calls for is known (followSwitch).
    feed.onProperties = { [weak screens] in Task { @MainActor in screens?.noteChange(hinge: true) } }
    feed.onSurface = { [weak screens] in Task { @MainActor in screens?.noteChange() } }
    // Which screen is in use, from the guest itself; an engine that cannot tell does not start (it says why, and its
    // caller starts one again later, as for any engine that is not ready).
    try await screens.resolve(deadline: Date().addingTimeInterval(Screens.settleSeconds), strict: true)
    screens.apply()
    return screens
  }

  func slot(_ id: UInt32) -> ScreenSlot? { slots.first { $0.id == id } }

  /** The contract's fields for an answer: screen, and on a foldable posture and hinge_degrees. */
  func answerFields() -> [String: Any] {
    var out: [String: Any] = ["screen": applied.json]
    if foldable {
      if let posture { out["posture"] = posture }
      if let hingeDegrees { out["hinge_degrees"] = (hingeDegrees * 10).rounded() / 10 }
      if unsteady { out["screens_unsteady"] = true }
    }
    return out
  }

  /**
   * How long the guest's display report may take to hold after a change: AXe 2.0's own bound
   * (ActivePanelReader waits up to this long for a lit, inactive panel to prove steady).
   */
  static let settleSeconds = FBSimulatorLitInactivePolicy.steadySeconds + 1

  /** A callback said a screen changed: read which one is in use again (once at a time; another read follows if more came). */
  func noteChange(hinge: Bool = false) {
    guard foldable else { return }
    if hinge { wantHinge = true }
    dirty = true; changing = true
    guard !refreshing else { return }
    refreshing = true
    Task { @MainActor in
      while dirty {
        dirty = false
        let hinge = wantHinge
        wantHinge = false
        try? await resolve(deadline: Date().addingTimeInterval(Self.settleSeconds), strict: false, hinge: hinge)
      }
      refreshing = false
      changing = false
      followSwitch()
      // An engine that only streams follows the screen in use at once; one that answers requests at their start.
      if follows { apply() }
      let waiting = waiters
      waiters = [:]
      for (_, waiter) in waiting { waiter.resume() }
    }
  }
  private var refreshing = false
  /** The engine's state becomes the screen in use as soon as it is read (a stream engine, whose one request never ends). */
  var follows = false
  private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

  /** Waits for the read going on (or the next one) to finish, or for timeout seconds, whichever comes first. */
  private func nextRead(timeout: TimeInterval) async {
    guard timeout > 0 else { return }
    let key = UUID()
    await withCheckedContinuation { (waiter: CheckedContinuation<Void, Never>) in
      waiters[key] = waiter
      Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
        self?.waiters.removeValue(forKey: key)?.resume()
      }
    }
  }

  /**
   * Waits until the screens are read and nothing more is pending, then until(slot, turn) holds for the screen in use
   * as read, each check after a read the screens' callbacks set off; false at the deadline.
   */
  func waitFor(deadline: Date, until: (ScreenSlot, Int) -> Bool = { _, _ in true }) async -> Bool {
    while true {
      if !refreshing && !changing, let slot = resolvedSlot, until(slot, resolvedRotation) { return true }
      let left = deadline.timeIntervalSinceNow
      if left <= 0 { return false }
      await nextRead(timeout: left)
    }
  }

  /** Reads the screen in use now (as a callback would make it), and waits for that read; hinge: its angle too. */
  func refreshNow(hinge: Bool = false) async {
    guard foldable else { return }
    noteChange(hinge: hinge)
    _ = await waitFor(deadline: Date().addingTimeInterval(Self.settleSeconds * 2))
  }

  /** The screen the hinge's posture puts in use: closed the outer, book and open the inner. */
  var expectedSlot: ScreenSlot? { posture.flatMap { p in slots.first { $0.role == (p == "closed" ? "outer" : "inner") } } }
  /** A switch the posture calls for and the guest has not made yet: the screen in use is read again until it is made. */
  private(set) var switchPending = false
  /**
   * Apple's 27.2 Duo moves its interface to the screen a posture calls for 15 to 17 s after the hinge gets there
   * (gate), and CoreSimulator calls back when the hinge moves but not when the guest switches (measured: the last
   * screen callback comes about 4.8 s after a close). So while the hinge's posture and the screen in use disagree,
   * every engine reads the guest's display report again, every switchPollSeconds, until they agree or switchWaitSeconds
   * pass (then it stays as the guest says, and a later callback starts this again).
   */
  static let switchPollSeconds = 0.25, switchWaitSeconds = 30.0
  private func followSwitch() {
    guard !switchPending, let expected = expectedSlot, expected.id != resolvedID else { return }
    switchPending = true
    noteResolve("switch pending: posture \(posture ?? "?") calls for screen \(expected.id), screen \(resolvedID) in use")
    Task { @MainActor in
      let until = Date().addingTimeInterval(Self.switchWaitSeconds)
      while Date() < until, let wanted = expectedSlot, wanted.id != resolvedID {
        try? await Task.sleep(nanoseconds: UInt64(Self.switchPollSeconds * 1_000_000_000))
        await refreshNow()
      }
      noteResolve("switch \(expectedSlot?.id == resolvedID ? "made" : "not made"): screen \(resolvedID) in use")
      switchPending = false
    }
  }
  private var wantHinge = false

  /**
   * Reads which screen is in use and how it is turned (the guest's display report), and the hinge's angle. A report
   * taken while the screens change (one lit while the other takes over) is read again until it holds, up to the
   * deadline. strict: a failure is thrown (at start); otherwise the last known screen stays.
   */
  func resolve(deadline: Date, strict: Bool, hinge readHinge: Bool = false) async throws {
    resolving = true
    defer { resolving = false }
    while true {
      do {
        let started = Date()
        let found = try await ActivePanelReader.discoverWithMetadata(for: simulator)
        let panel = found.readback.snapshot.activePanel
        let rotation = Self.degrees(panel.currentOrientation)
        let discoverMs = ms(started)
        // The hinge's angle (a fresh sample from the phone's motion service) when asked, when the screen in use or its
        // turn changed, or never read yet: a fold changes the screen or its turn, so the posture follows it.
        let changed = panel.identity.displayID != resolvedID || rotation != resolvedRotation
        if readHinge || changed || hingeDegrees == nil {
          let postureBefore = posture
          if let hinge = try? await FBSimulatorHingeReader.read(for: simulator) { hingeDegrees = hinge.mechanicalDegrees }
          if posture != postureBefore { for call in onPosture { call() } }
        }
        bootIdentity = found.bootIdentity
        lastResolve = ["active": Int(panel.identity.displayID), "rotation": rotation, "ms": ms(started), "discover_ms": discoverMs, "basis": found.readback.snapshot.selectionBasis.rawValue,
                       "hinge_degrees": hingeDegrees ?? -1, "panels": found.readback.snapshot.panels.map { ["id": Int($0.identity.displayID), "active": $0.active ?? false, "backlight": $0.backlightState ?? "", "rotation": Self.degrees($0.currentOrientation)] as [String: Any] }]
        noteResolve("resolved active \(panel.identity.displayID) rot \(rotation) in \(ms(started)) ms")
        unsteady = false
        if panel.identity.displayID != resolvedID || rotation != resolvedRotation {
          resolvedID = panel.identity.displayID; resolvedRotation = rotation; generation += 1
        }
        return
      } catch {
        // A report taken while the screens change (FBSimulatorContextError.changedDuringRead, or no single panel
        // active yet) is the one transient AXe names: read again (at its own 100 ms pace) until the deadline; any
        // other failure ends the read.
        let transient = (error as? FBSimulatorContextError).map { if case .changedDuringRead = $0 { return true } else { return false } } ?? false
          || [ActivePanelValidationError.missingActiveFlag].contains((error as? ActivePanelReadError)?.validationFailure ?? .invalidDisplayCount)
          || { if case .activeStateUnavailable = (error as? ActivePanelReadError)?.validationFailure { return true } else { return false } }()
        noteResolve("resolve failed \(transient ? "(transient)" : ""): \(String(describing: error).prefix(160))")
        if !transient || Date() > deadline {
          lastResolve["error"] = "\(error)"
          unsteady = true
          if strict { throw EngineError(message: "which screen is in use could not be read (\(error)): the phone's display report is not steady, as after a fold cut off midway; folding it once settles it") }
          return
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    }
  }

  static func degrees(_ rotation: ActivePanelRotation) -> Int {
    switch rotation { case .rot0: return 0; case .rot90: return 90; case .rot180: return 180; case .rot270: return 270; @unknown default: return 0 }
  }

  /**
   * Makes the engine's state that of the screen in use as last read: the screen that was in use keeps its own
   * (caret zones, the window's place, the web scan), the new one's comes back, and the last read is the past. A screen
   * whose turn changed starts afresh (its window and web scan were measured the other way). Answers whether it changed.
   */
  @discardableResult
  func apply() -> Bool {
    guard let next = slot(resolvedID) else { return false }
    let turned = next.geometry.rotation != resolvedRotation
    if next === applied && !turned && activeWatcherBox.slot === next { return false }
    let previous = applied
    previous.caretZones = caretZones; previous.lastPlacement = lastPlacement; previous.lastWebScan = lastWebScan
    if turned {
      next.geometry.rotation = resolvedRotation
      next.lastPlacement = nil; next.lastWebScan = nil; next.caretZones = []
    }
    applied = next
    activate(next)
    for call in onChange { call(next) }
    return true
  }

  /** Before each piece of input: the screen it was aimed at is still the one in use, and nothing is changing. */
  func inputAllowed(aimedAt slot: ScreenSlot, generation seen: Int) -> ScreenError? {
    guard foldable else { return nil }
    if unsteady {
      return ScreenError(code: "screen_unknown", message: "Which screen is in use cannot be read (the phone's display report is not steady, as after a fold cut off midway): no input was sent. Fold the phone once to settle it.")
    }
    if generation != seen || resolvedID != slot.id {
      return ScreenError(code: "screen_changed", message: "The screen in use changed (now the \(self.slot(resolvedID)?.role ?? "other") screen): no more input was sent. Read the screen again.")
    }
    if changing {
      return ScreenError(code: "screen_changing", message: "The screens are changing (a fold): no more input was sent. Read the screen again in a moment.")
    }
    return nil
  }

  /** Waits (up to the time the guest's report takes to hold) until no change is pending, so an input starts on a known screen. */
  func waitUntilSteady() async {
    if foldable { _ = await waitFor(deadline: Date().addingTimeInterval(Self.settleSeconds)) }
    apply()
  }

  /** The screen in use as the resolver last found it, and whether that is the one applied. */
  var resolvedSlot: ScreenSlot? { slot(resolvedID) }
  var resolvedTurn: Int { resolvedRotation }

  func close() { feed?.close() }
  /** The screens' callbacks as they came, and how many of each (the screens op). */
  var callbackLog: [String] { feed?.recent() ?? [] }
  var callbackCounts: [String: [Int]] { feed?.callbackCounts() ?? [:] }
  func noteResolve(_ text: String) { feed?.note(0, text) }
}

func surfaceID(_ surface: IOSurface) -> UInt32 { IOSurfaceGetID(unsafeBitCast(surface, to: IOSurfaceRef.self)) }

/** The slot whose buffer the seed clock ticks (it runs on a queue of its own). */
final class ActiveWatcherBox: @unchecked Sendable {
  private let lock = NSLock()
  private var current: ScreenSlot?
  var slot: ScreenSlot? { lock.lock(); defer { lock.unlock() }; return current }
  func set(_ s: ScreenSlot) { lock.lock(); current = s; lock.unlock() }
}
let activeWatcherBox = ActiveWatcherBox()

/** The engine's globals for one screen (main.swift and Settle.swift read them): the screen in use's. */
@MainActor
func activate(_ slot: ScreenSlot) {
  activeWatcherBox.set(slot)
  screenWatcher = slot.watcher
  writeClock = slot.clock
  caretZones = slot.caretZones
  lastPlacement = slot.lastPlacement
  lastWebScan = slot.lastWebScan
  screenGeometry = slot.geometry
  display = slot.geometry.points
  pixelScale = slot.geometry.scale
  keptRead = nil
  lastTreeSignature = 0
}

/**
 * Each integrated screen's buffer and changes, from CoreSimulator's screen callbacks: its surfaces (the first is the
 * picture), a call per frame drawn (its damage), and its properties (power, backlight, mode: a fold).
 */
final class ScreenFeed: @unchecked Sendable {
  private let screens: [any SimScreen]
  private let registration = UUID()
  private let queue = DispatchQueue(label: "simulator-use-engine screens", qos: capped(.default))
  var onProperties: (() -> Void)?
  var onSurface: (() -> Void)?
  /** Callbacks seen, per screen id: surfaces, frames, properties (the screens op shows them). */
  private let lock = NSLock()
  private var counts: [UInt32: [Int]] = [:]
  /** The last callbacks, timed (frames only the first after a second without one): what a fold looks like from here. */
  private var log: [String] = []
  private var lastFrame: [UInt32: Date] = [:]
  private let born = Date()
  func note(_ id: UInt32, _ what: String) {
    lock.lock(); defer { lock.unlock() }
    if what == "frame" {
      let quiet = lastFrame[id].map { Date().timeIntervalSince($0) > 1 } ?? true
      lastFrame[id] = Date()
      if !quiet { return }
    }
    log.append("\(Int(Date().timeIntervalSince(born) * 1000)) \(id) \(what)")
    if log.count > 80 { log.removeFirst(log.count - 80) }
  }
  func recent() -> [String] { lock.lock(); defer { lock.unlock() }; return log }

  private init(screens: [any SimScreen]) { self.screens = screens }

  static func start(_ simulator: FBSimulator, slots: [ScreenSlot]) async throws -> ScreenFeed {
    guard let io = simulator.device.io, let typed = io.ioPorts() else { throw EngineError(message: "the phone's screens are not reachable (no IO ports)") }
    let ports: [Any] = typed
    var all: [any SimScreen] = []
    for port in ports {
      guard let adapter = (port as? any SimDeviceIOPortInterface)?.descriptor as? any SimScreenAdapter else { continue }
      let screens: [any SimScreen] = try await withCheckedThrowingContinuation { cont in
        adapter.enumerateScreens(withCompletionQueue: DispatchQueue.global(qos: .userInitiated)) { screens, error in
          if let error { cont.resume(throwing: error) } else { cont.resume(returning: screens ?? []) }
        }
      }
      all += screens
    }
    let wanted = all.filter { screen in slots.contains { $0.id == screen.screenProperties?.screenID } }
    guard wanted.count == slots.count else { throw EngineError(message: "the screen callbacks reach \(wanted.count) of the phone's \(slots.count) screens") }
    let feed = ScreenFeed(screens: wanted)
    // Each screen's first picture straight from its display port, in case the callbacks give none until it changes.
    feed.seedSurfaces(ports: ports, slots: slots)
    for screen in wanted {
      guard let id = screen.screenProperties?.screenID, let slot = slots.first(where: { $0.id == id }) else { continue }
      screen.registerScreenCallbacks(with: feed.registration, callbackQueue: feed.queue, frameCallback: { [weak feed] in
        slot.watcher.didReceiveDamageRect(); feed?.count(id, 1); feed?.note(id, "frame")
      }, surfacesChangedCallback: { [weak feed] first, _ in
        // A new buffer (by its IOSurface id: the same buffer can come again in a new wrapper).
        if let first, slot.watcher.currentSurface().map(surfaceID) != surfaceID(first) { slot.watcher.didChange(first); feed?.onSurface?() }
        feed?.count(id, 0); feed?.note(id, "surfaces")
      }, propertiesChangedCallback: { [weak feed] properties in
        feed?.count(id, 2)
        feed?.note(id, "properties power \(properties.powerState) backlight \(properties.backlight?.state ?? -1) orientation \(properties.uiOrientation) seed \(properties.seed)")
        let size = properties.pixelSize
        if size.width > 0, size.height > 0, let scale = properties.currentMode?.preferredUIScale, scale > 0 {
          let native = size, s = CGFloat(scale)
          DispatchQueue.main.async { if slot.geometry.native != native || slot.geometry.scale != s { slot.geometry.native = native; slot.geometry.scale = s } }
        }
        feed?.onProperties?()
      })
    }
    return feed
  }

  /**
   * The display ports of class 0 (the panels), matched to the screens by size: their buffer now. Read as FBFramebuffer
   * reads the main one (its descriptor's protocols, each call guarded: they are proxies to CoreSimulator's service).
   */
  private func seedSurfaces(ports: [Any], slots: [ScreenSlot]) {
    for port in ports {
      guard let descriptor = (port as? any SimDeviceIOPortInterface)?.descriptor as AnyObject?,
            descriptor.conforms(to: SimDisplayIOSurfaceRenderable.self), descriptor.responds(to: NSSelectorFromString("state")),
            let state = (try? FBObjCExceptionGuard.guarded({ descriptor.perform(NSSelectorFromString("state"))?.takeUnretainedValue() })) as? any SimDisplayDescriptorState,
            state.displayClass == 0,
            let slot = slots.first(where: { Int($0.geometry.native.width) == Int(state.defaultWidthForDisplay) && Int($0.geometry.native.height) == Int(state.defaultHeightForDisplay) }),
            slot.watcher.currentSurface() == nil,
            let renderable = descriptor as? any SimDisplayIOSurfaceRenderable else { continue }
      let surface = ((try? FBObjCExceptionGuard.guarded({ renderable.framebufferSurface })) as? IOSurface)
        ?? ((try? FBObjCExceptionGuard.guarded({ renderable.ioSurface })) as? IOSurface)
      if let surface { slot.watcher.didChange(surface) }
    }
  }

  private func count(_ id: UInt32, _ index: Int) {
    lock.lock(); var c = counts[id] ?? [0, 0, 0]; c[index] += 1; counts[id] = c; lock.unlock()
  }
  func callbackCounts() -> [String: [Int]] { lock.lock(); defer { lock.unlock() }; return Dictionary(uniqueKeysWithValues: counts.map { (String($0.key), $0.value) }) }

  func close() { for screen in screens { screen.unregisterScreenCallbacks(with: registration) } }
}
