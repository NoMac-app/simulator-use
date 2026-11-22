// simulator-use engine (prototype): one process per booted Simulator that loads CoreSimulator's
// private frameworks, the HID connection and the accessibility translator once, then answers JSON
// requests, one per line on stdin, one JSON answer per line on stdout. Built on AXe's
// FBSimulatorControl frameworks (MIT).
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// FBSimulatorControl 2 is annotated for Swift concurrency only in part: its classes cross queues here as they did in 1.x.
@preconcurrency import FBControlCore
@preconcurrency import FBSimulatorControl

let started = Date()
func ms(_ since: Date) -> Int { Int(Date().timeIntervalSince(since) * 1000) }
/** Whoever read the engine's answers is gone (its end of the pipe closed): the engine closes its session and ends. */
var outputGone = false
func emit(_ object: [String: Any]) {
  var data = try! JSONSerialization.data(withJSONObject: object)
  data.append(0x0A)
  // write(2), with SIGPIPE ignored (below): a reader that went away is an error here (EPIPE), not the engine's end
  // by a signal with its session left open and no close time written, which let the next engine open one too soon
  // and left the phone refusing sessions.
  data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
    var sent = 0
    while sent < buffer.count {
      let n = write(STDOUT_FILENO, buffer.baseAddress! + sent, buffer.count - sent)
      if n > 0 { sent += n; continue }
      if n < 0 && errno == EINTR { continue }
      outputGone = true
      return
    }
  }
}
signal(SIGPIPE, SIG_IGN)
struct EngineError: Error { let message: String }

let args = CommandLine.arguments
guard let udidIndex = args.firstIndex(of: "--udid"), udidIndex + 1 < args.count else { emit(["ok": false, "error": "usage: engine --udid UDID"]); exit(2) }
let udid = args[udidIndex + 1]
/** A session's own device set (a folder on its volume); the user's default set when absent. */
let deviceSetPath: String? = args.firstIndex(of: "--set").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
let logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: false, withDebugLogging: false)
FBControlCoreGlobalConfiguration.defaultLogger = logger

// Custom actions are left out unless asked for (keys): simulator-use never shows them, and on a web page a read with
// them took about 2 s in one run (0.1 s in another) against 60 to 400 ms without.
let outputKeys: Set<FBAXKeys> = [.label, .frame, .value, .uniqueID, .type, .title, .frameDict, .help, .enabled, .role, .roleDescription, .subrole, .contentRequired, .pid]
/**
 * What simulator-use's screen reads use (src/look/snapshot.ts), asked for with "lean": the frame once (as a
 * dictionary), no title, hint or contentRequired. About a tenth fewer calls into the phone per read (October 31: 907
 * against 1009 for the sign-in screen's 102 elements, 190 against 211 ms).
 */
let leanKeys: Set<FBAXKeys> = [.label, .frameDict, .value, .uniqueID, .type, .role, .roleDescription, .subrole, .enabled, .pid]

func keyNamed(_ name: String) -> FBAXKeys? {
  switch name {
  case "label": return .label; case "frame": return .frame; case "value": return .value; case "uniqueID": return .uniqueID
  case "type": return .type; case "title": return .title; case "frameDict": return .frameDict; case "help": return .help
  case "enabled": return .enabled; case "customActions": return .customActions; case "role": return .role
  case "roleDescription": return .roleDescription; case "subrole": return .subrole; case "contentRequired": return .contentRequired; case "pid": return .pid
  case "traits": return .traits; case "expanded": return .expanded; case "placeholder": return .placeholder; case "hidden": return .hidden
  case "focused": return .focused; case "isRemote": return .isRemote
  default: return nil
  }
}
var lastCPU: Double = 0
func cpuMs() -> Int {
  var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
  let now = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
  defer { lastCPU = now }; return Int(now - lastCPU)
}
/** The last tree any read returned, to tell a screen that moved but did not change yet (an app still opening). */
var lastTreeSignature = 0
/** Whether the last readFrontmost's tree is whole: no reload, or one whose elements then read the same twice. */
var lastReadStable = true
var lastFrontPid = -1
/**
 * Content drawn by another process (a web page: Safari's or an app's WKWebView) is not in the frontmost app's tree.
 * With readRemote set, FBSimulatorControl hit-tests the screen on a grid where no native element lies and adds what
 * it finds there (its remote-content phase); readProfile asks it for counts and timings. lastReadReport holds what the
 * last read reported (coverage, profile), for the answer.
 */
var readRemote: FBAccessibilityRemoteContentOptions? = nil
var readProfile = false
var lastReadReport: [String: Any] = [:]
/**
 * A web page (an app's WKWebView, Safari) is drawn by its own web process: the app's tree holds only an empty
 * scroll area there, and FBSimulatorControl's remote-content phase skips it (the area's own frame counts as covered).
 * Point reads inside it do answer with the page's elements, so a read with an empty web area sweeps it point by point
 * (webScan below), within webBudget seconds, and reuses the result while the screen's pixels are unchanged.
 */
var webScanOn = true
var webBudget: TimeInterval = 2.5
var screenWatcher: DamageWatcher? = nil
var lastWebScan: (seed: UInt32, region: CGRect, elements: [[String: Any]])? = nil
/** How long each accessibility read of the last readFrontmost took, in ms (the describe answer carries it). */
var lastSerializeMs: [Int] = []
/** What the screen shows, not how it is drawn: kinds, labels and ids (a pressed icon or a moving frame is the same screen). */
func signature(_ tree: Any) -> Int {
  var hasher = Hasher()
  func walk(_ node: Any) {
    if let list = node as? [Any] { list.forEach(walk); return }
    guard let n = node as? [String: Any] else { return }
    hasher.combine(n["type"] as? String); hasher.combine(n["AXLabel"] as? String); hasher.combine(n["AXUniqueId"] as? String)
    (n["children"] as? [Any])?.forEach(walk)
  }
  walk(tree); return hasher.finalize()
}
func isEmptyApp(_ tree: Any) -> Bool {
  let roots = (tree as? [[String: Any]]) ?? []
  return roots.isEmpty || !roots.contains { (($0["children"] as? [Any])?.count ?? 0) > 0 }
}
func withDefaults(_ any: Any) -> Any {
  if let list = any as? [Any] { return list.map(withDefaults) }
  guard var element = any as? [String: Any] else { return any }
  for (key, value) in element { element[key] = withDefaults(value) }
  if element["type"] != nil, element["traits"] == nil { element["traits"] = [String]() }
  return element
}

/** A screenshot as an opaque PNG: a screen has no transparency, so the file carries no alpha channel. */
func opaquePNG(_ data: Data) throws -> Data {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw EngineError(message: "screenshot could not be decoded") }
  if [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo) { return data }
  guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw EngineError(message: "png encoder unavailable") }
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  let result = NSMutableData()
  guard let flat = ctx.makeImage(), let dest = CGImageDestinationCreateWithData(result, UTType.png.identifier as CFString, 1, nil) else { throw EngineError(message: "png encoder unavailable") }
  CGImageDestinationAddImage(dest, flat, nil)
  guard CGImageDestinationFinalize(dest) else { throw EngineError(message: "png encoding failed") }
  return result as Data
}

func jpeg(fromPNG data: Data, maxPoints: (Double, Double)?, quality: Double) throws -> Data {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw EngineError(message: "screenshot could not be decoded") }
  var out = image
  if let (w, h) = maxPoints, w > 0, h > 0, let ctx = CGContext(data: nil, width: Int(w), height: Int(h), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    if let scaled = ctx.makeImage() { out = scaled }
  }
  let result = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(result, UTType.jpeg.identifier as CFString, 1, nil) else { throw EngineError(message: "jpeg encoder unavailable") }
  CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { throw EngineError(message: "jpeg encoding failed") }
  return result as Data
}

/** Counts the Simulator's screen updates: "settled" means no update for a quiet period. */
final class DamageWatcher: NSObject, FBFramebufferConsumer, @unchecked Sendable {
  private let lock = NSLock(); private var lastUpdate = Date(); private var updates = 0
  var surface: IOSurface?; private var lastSeed: UInt32 = 0
  func didChange(_ surface: IOSurface?) { lock.lock(); if let surface { self.surface = surface }; lock.unlock(); mark() }
  /** The screen's buffer, read under the lock didChange writes it under (it is read from several queues). */
  func currentSurface() -> IOSurface? { lock.lock(); defer { lock.unlock() }; return surface }
  func didReceiveDamageRect() { mark() }
  private func mark() { lock.lock(); lastUpdate = Date(); updates += 1; lock.unlock() }
  /** The surface's seed changes whenever its contents do: a free check, unlike a screenshot. */
  func pollSeed() { lock.lock(); defer { lock.unlock() }
    guard let surface else { return }
    let seed = IOSurfaceGetSeed(unsafeBitCast(surface, to: IOSurfaceRef.self))
    if seed != lastSeed { lastSeed = seed; lastUpdate = Date(); updates += 1 } }

  func snapshot() -> (Date, Int) { lock.lock(); defer { lock.unlock() }; return (lastUpdate, updates) }
  /** The surface's seed now: equal seeds, unchanged pixels (damage callbacks also come without a change). */
  func currentSeed() -> UInt32? { lock.lock(); defer { lock.unlock() }
    guard let surface else { return nil }
    return IOSurfaceGetSeed(unsafeBitCast(surface, to: IOSurfaceRef.self)) }
}
/** Waits until the screen has not changed for quietMs (or timeoutMs passes); returns waited ms, updates seen and whether it settled. */
func settle(_ watcher: DamageWatcher, quietMs: Double, timeoutMs: Double, firstChangeMs: Double = 0) async -> (Int, Int, Bool) {
  let start = Date(); watcher.pollSeed(); let (_, before) = watcher.snapshot()
  // After an input iOS may start its animation a few hundred ms later: wait for the first change first.
  if firstChangeMs > 0 {
    while Date().timeIntervalSince(start) * 1000 < firstChangeMs {
      try? await Task.sleep(nanoseconds: 15_000_000); watcher.pollSeed()
      if watcher.snapshot().1 != before { break }
    }
    if watcher.snapshot().1 == before { return (ms(start), 0, true) }
  }
  while true {
    try? await Task.sleep(nanoseconds: 15_000_000)
    watcher.pollSeed()
    let (last, count) = watcher.snapshot()
    let quietFor = Date().timeIntervalSince(max(last, start)) * 1000
    if quietFor >= quietMs { return (ms(start), count - before, true) }
    if Date().timeIntervalSince(start) * 1000 >= timeoutMs { return (ms(start), count - before, false) }
  }
}
final class StreamCounter: @unchecked Sendable {
  let start: Date; var bytes = 0, chunks = 0, first = -1
  init(start: Date) { self.start = start }
  func add(_ n: Int) { bytes += n; chunks += 1; if first < 0 { first = ms(start) } }
}
func blocking(_ work: @escaping @Sendable () throws -> Void) async throws {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
    DispatchQueue.global().async { do { try work(); cont.resume() } catch { cont.resume(throwing: error) } }
  }
}
/**
 iOS 27 Simulators read accessibility only once an XCTest "remote automation session" has loaded it, and an app
 launched afterwards can read empty until it is loaded again. FBSimulatorControl's reads, unless told otherwise
 (AXe 2.0 reads with bootstrap: false first), open a session, load accessibility and close the session before every
 request: about a second a read, and in a long-lived process new sessions soon time out. The engine replaces that
 class method (installPersistentBootstrap): on the session path it opens one session per phone, keeps it for its
 whole life, and reloads accessibility on that same session when the frontmost app reads empty (forceBootstrap); on
 the axe path it runs the framework's own short-lived session, only for such a reload, under the engine's lock.
 */
var bootstrapCount = 0
var signalSources: [DispatchSourceSignal] = []
var seedClocks: [DispatchSourceTimer] = []
var forceBootstrap = false
var automationSession: AnyObject?
var skipBootstrap = CommandLine.arguments.contains("--no-bootstrap")

/**
 * How accessibility is kept loaded, for every read (--reads, else SIMULATOR_USE_ENGINE_READS; session when neither says).
 * - session: one automation session per phone, opened by the first read and kept for the engine's life; a read that
 *   comes back empty reloads accessibility on it (installPersistentBootstrap).
 * - axe: AXe 2.0's own way: reads go straight to the phone, and only one that comes back empty, or fails for want
 *   of a translation object, loads accessibility again through a short-lived session (opened, loaded and closed,
 *   under the same lock and gap as ours).
 * Either way no read pays a session of its own: that is the slow per-call path (FBSimulatorControl's default, about
 * a second a read), which the ready line names "per-call" when the hook that prevents it could not be installed, and
 * which scripts/engine-check.mjs fails on.
 */
enum ReadPath: String { case session, axe }
let readPath: ReadPath = {
  let given = args.firstIndex(of: "--reads").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    ?? ProcessInfo.processInfo.environment["SIMULATOR_USE_ENGINE_READS"]
  return given.flatMap(ReadPath.init(rawValue:)) ?? .session
}()
/** Whether the bootstrap hook is in place: without it every read would open a session of its own. */
var hookInstalled = false
/** Automation sessions opened, kept or short-lived (every answer carries the count); a request that failed is not one. */
var sessionsOpened = 0
/** The way reads actually go, for the ready line and every read's answer. */
var readPathName: String { hookInstalled ? readPath.rawValue : "per-call" }

/** The frontmost app's element. reload: load accessibility first (a read that came back empty, or failed). */
@MainActor
func frontmostElement(_ simulator: FBSimulator, reload: Bool) async throws -> FBAccessibilityElement {
  // A foldable's screen in use, read by its display (the default query reads another screen). That read skips the
  // framework's bootstrap, so the hook is asked first, as the framework would: the kept session, or a reload on it.
  if let slot = foldSlot() {
    if !skipBootstrap && (readPath == .session || reload) {
      if reload { forceBootstrap = true }
      try? FBSimulatorControlFrameworkLoader.bootstrapAccessibility(forSimulatorDevice: simulator.device, timeout: 10, logger: logger)
    }
    return try await simulator.accessibilityElementForFrontmostApplication(displayID: slot.id, displayContext: try displayContext(slot.geometry, id: slot.id))
  }
  switch readPath {
  case .session:
    // The framework calls its bootstrap before the read; the hook answers it from the kept session.
    if reload { forceBootstrap = true }
    return try await simulator.accessibilityElementForFrontmostApplication()
  case .axe:
    return try await simulator.accessibilityElementForFrontmostApplication(bootstrap: reload)
  }
}
/** The element at a screen point, as frontmostElement. */
@MainActor
func pointElement(_ simulator: FBSimulator, _ point: CGPoint, reload: Bool = false) async throws -> FBAccessibilityElement {
  // A foldable: the point on the screen in use's own (unturned) points, by its display.
  if let slot = foldSlot() {
    if reload { forceBootstrap = true }
    return try await simulator.accessibilityElement(atNativePoint: slot.geometry.nativePoint(point), displayID: slot.id)
  }
  switch readPath {
  case .session:
    if reload { forceBootstrap = true }
    return try await simulator.accessibilityElement(at: point)
  case .axe:
    return try await simulator.accessibilityElement(at: point, bootstrap: reload)
  }
}
func objcCall(_ target: AnyObject, _ name: String) -> IMP? {
  let sel = NSSelectorFromString(name)
  if let cls = target as? AnyClass { return class_getMethodImplementation(object_getClass(cls), sel) }
  return class_getMethodImplementation(object_getClass(target), sel)
}
var sessionTurnMs = 0, sessionRecoveries = 0
/** The phone's XCTest daemons stopped inside it (launchd starts them again on the next request). */
func restartTestDaemons() {
  closeOnExecAll()
  for label in ["com.apple.testmanagerd", "com.apple.dt.automationmode-writer", "com.apple.dt.AutomationModeUI"] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["simctl"] + (deviceSetPath.map { ["--set", $0] } ?? []) + ["spawn", udid, "launchctl", "stop", label]
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    try? process.run(); process.waitUntilExit()
  }
  Thread.sleep(forTimeInterval: 2)
}
/**
 * testmanagerd's log, streamed from the phone while a session request waits (`simctl spawn … log stream`, its own
 * subsystem's lines): sessionWait's signal (LoadLog, SessionWait.swift). Started before the request. A first request
 * on a phone just booted, where a process spawned takes 3 to 5 s to start on a busy Mac, waits for it to listen
 * (waitsBeforeRequest, logListenWaitSeconds), so the testmanagerd that starts for the request is heard from its first
 * line; elsewhere the stream listens within a second, before testmanagerd has started. Silence counts only from when
 * the stream listens (sessionWait's `listenedAt`); a load that began before (a testmanagerd already there) and is not
 * seen leaves its request to the first timeout, as before there was a log. Never a read of the phone, which before its
 * accessibility is loaded poisons its CoreSimulatorBridge (SessionWait.swift). nil when the stream cannot start: no
 * load is then seen.
 */
func startLoadLog() -> (log: LoadLog, process: Process)? {
  let log = LoadLog(), process = Process(), pipe = Pipe()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  process.arguments = ["simctl"] + (deviceSetPath.map { ["--set", $0] } ?? []) + ["spawn", udid, "log", "stream", "--style", "compact",
    "--level", "info", "--predicate", "process == \"testmanagerd\" AND subsystem == \"com.apple.dt.xctest\""]
  process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
  var pending = Data(), heard = false
  pipe.fileHandleForReading.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { handle.readabilityHandler = nil; return }
    pending.append(data)
    while let end = pending.firstIndex(of: 0x0A) {
      let line = String(decoding: pending[pending.startIndex..<end], as: UTF8.self)
      pending.removeSubrange(pending.startIndex...end)
      if !heard && line.hasPrefix("Filtering the log data") { heard = true; log.listening() }
      log.note(line)
    }
  }
  do { try process.run() } catch { pipe.fileHandleForReading.readabilityHandler = nil; return nil }
  return (log, process)
}
/**
 * App accessibility switched on inside the phone (native/axon, beside the engine, spawned there) as the engine
 * starts, and again after a restart of the phone's test daemons. testmanagerd makes the same call as it loads accessibility for a session, but after a boot it starts
 * 7 to 17 s after the request on a busy Mac and then waits 11 to 18 s for the phone's apps to load it; switched on at
 * once, the load runs while testmanagerd starts, and its own load finds it done (November 17, 2026, a Session Mac:
 * "Beginning AX loading sequence" and "Finished loading AX" in the same second; the first read 11.7 and 12.0 s from
 * the engine's start, against 20.6 and 26.8 s without). Not a read of the phone, which before its accessibility is
 * loaded poisons its CoreSimulatorBridge (SessionWait.swift); reads that reach the bridge once it is on fail for want of a
 * translation object until the apps' load is done, and then answer (November 17, 2026: every one of 8 trials and 3
 * throttled phones read). The engine's start does not wait for it; a first request on a phone just booted does
 * (AccessibilitySwitching, waitsBeforeRequest). The process is kept until it ends, its outcome written to the session log.
 */
var accessibilitySwitch: Process?
/**
 * Spawns `path` in the phone through CoreSimulator (SimDevice's spawnAsyncWithPath, as AXe's process launches do): no
 * xcrun or simctl process to start first, which cost 1.8 to 4.3 s on a Session Mac right after a boot. `done` gets the
 * exit status, or nil when the spawn failed. False when the device has no such method.
 */
func spawnInPhone(_ device: AnyObject, _ path: String, done: @escaping (Int32?) -> Void) -> Bool {
  let name = "spawnAsyncWithPath:options:terminationQueue:terminationHandler:completionQueue:completionHandler:"
  let sel = NSSelectorFromString(name)
  guard device.responds(to: sel), let imp = objcCall(device, name) else { return false }
  typealias SpawnFn = @convention(c) (AnyObject, Selector, NSString, NSDictionary, DispatchQueue, AnyObject, DispatchQueue, AnyObject) -> Void
  let queue = DispatchQueue(label: "simulator-use-engine.spawn")
  // argv[0] is the path: SimDevice does not add it (AXe's FBSimulatorProcessSpawnCommands). Through the phone's launchd.
  let options: NSDictionary = ["arguments": [path], "environment": [String: String](), "standalone": false]
  let terminated: @convention(block) (Int32) -> Void = { status in done(status) }
  let completed: @convention(block) (NSError?, pid_t) -> Void = { error, _ in if error != nil { done(nil) } }
  unsafeBitCast(imp, to: SpawnFn.self)(device, sel, path as NSString, options, queue, terminated as AnyObject, queue, completed as AnyObject)
  return true
}
func switchAccessibilityOn(device: AnyObject?) {
  guard let engine = Bundle.main.executableURL?.resolvingSymlinksInPath() else { return }
  let helper = engine.deletingLastPathComponent().appendingPathComponent("simulator-use-axon").path
  guard FileManager.default.isExecutableFile(atPath: helper) else { sessionLog("app accessibility not switched on: no simulator-use-axon beside the engine"); return }
  let started = Date(), finished = accessibilitySwitching.begin()
  // Off the caller's thread: CoreSimulator's spawn call itself can take a while on a busy phone, and the engine's start
  // waits for nothing of it (a session request waits for `finished`, AccessibilitySwitching).
  DispatchQueue.global(qos: .userInitiated).async { spawnAccessibilitySwitch(device: device, helper: helper, started: started, finished: finished) }
}
private func spawnAccessibilitySwitch(device: AnyObject?, helper: String, started: Date, finished: @escaping () -> Void) {
  // The handler gets a wait status (SimDevice's terminationHandler): the exit code is its second byte.
  if let device, spawnInPhone(device, helper, done: { status in
    let outcome = status.map { $0 & 0x7f == 0 ? "exit \(($0 >> 8) & 0xff)" : "signal \($0 & 0x7f)" } ?? "spawn failed"
    sessionLog("app accessibility switched on in the phone in \(ms(started)) ms (\(outcome))")
    finished()
  }) { return }
  // No CoreSimulator spawn to call: simctl's.
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  process.arguments = ["simctl"] + (deviceSetPath.map { ["--set", $0] } ?? []) + ["spawn", udid, helper]
  process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
  process.terminationHandler = { p in sessionLog("app accessibility switched on in the phone in \(ms(started)) ms (simctl, exit \(p.terminationStatus))"); finished() }
  do { try process.run(); accessibilitySwitch = process } catch { sessionLog("app accessibility not switched on: \(error.localizedDescription)"); finished() }
}
/**
 * App accessibility being switched on in the phone (switchAccessibilityOn), for a session request to wait for: at most
 * accessibilityWaitSeconds from the switch's start, never past the request's deadline. A process spawned into a phone
 * just booted takes 3 to 5 s to start on a busy Mac, and one sent with the request competed with testmanagerd's own
 * start and its load: requested at once, sessions answered sooner but the phone's first reads then failed for 1 to 3
 * s more (first read median 17.3 s); requested once the switch was in (3 to 5 s later), testmanagerd found
 * accessibility on and the first read came at 15.9 s (November 17, 2026, 10 trials each, a Session Mac). On a phone
 * held at background priority the switch takes 10 to 30 s: the request goes at the bound. Never when a testmanagerd
 * already runs in the phone (a UI test, an earlier session): its load is done, and the request goes at once.
 */
final class AccessibilitySwitching: @unchecked Sendable {
  private let lock = NSLock(), group = DispatchGroup()
  private var startedAt: DispatchTime?
  /** A switch begins: the closure marks its end (once, whatever calls it again). */
  func begin() -> () -> Void {
    lock.lock(); startedAt = .now(); group.enter(); lock.unlock()
    let group = self.group, endLock = NSLock()
    var ended = false
    return { endLock.lock(); defer { endLock.unlock() }; if !ended { ended = true; group.leave() } }
  }
  /** Waits for the switches begun so far, within the bound: nil when none was begun, else whether they ended. */
  func wait(deadline: DispatchTime) -> Bool? {
    lock.lock(); let started = startedAt; lock.unlock()
    guard let started else { return nil }
    return group.wait(timeout: min(started + accessibilityWaitSeconds, deadline)) == .success
  }
}
let accessibilitySwitching = AccessibilitySwitching()
let accessibilityWaitSeconds = 6.0
/**
 * How long a first request on a phone just booted waits for testmanagerd's log to listen, from the stream's start: a
 * spawn into a phone just booted takes 3 to 5 s to start on a busy Mac (November 17, 2026: the stream listened 2.7 to
 * 4.6 s after its start); on a phone held at background priority 10 to 30 s, and the request goes at the bound.
 */
let logListenWaitSeconds = 6.0
/**
 * A phone up less than this is one just booted, whose first request waits for app accessibility's switch: its spawns
 * take seconds and compete with testmanagerd's start (a pool phone's first read comes within seconds of its boot; one
 * held at background priority takes 60 to 90 s to be read).
 */
let youngPhoneSeconds = 180.0
/**
 * Opens an automation session: the request, then its answer, waited for as sessionWait (SessionWait.swift) says,
 * never past `deadline`. The phone's testmanagerd answers once accessibility is loaded in the phone: the first request
 * after a boot has it load accessibility first, and it allows itself 120 s for that ("Waiting 120.0s for AX to finish
 * loading", its log). Right after a boot that took 23 to 26 s on a busy 6-core virtual Mac (November 16, 2026: 8 s
 * to start, 16.6 s to load), and given up at 12 s, with the daemons restarted mid-load, the first read came no
 * sooner. So testmanagerd's own log is followed while the request waits (startLoadLog): while it says it is loading
 * accessibility, it is waited for (its 120 s, the deadline; a first request only until restartReserveNanos before
 * it, so a testmanagerd stuck in its first load is restarted in time); once it says the load finished, it has
 * `timeout` to answer, as a testmanagerd with nothing to load does in about a second. One that does not answer, and
 * one that shows no load under way at the first timeout, is a phone that refuses sessions (it was there before, or
 * came after a restart: November 16, Mac 7, such a testmanagerd waited out its 120 s, a command, again and again), and
 * the hook restarts its daemons.
 */
func openSession(device: AnyObject, timeout: Double, deadline: DispatchTime, restartingDaemons: Bool = false) -> (AnyObject?, String?) {
  guard let turnMs = takeSessionTurn(deadline: deadline) else {
    sessionLog("open not tried: another engine held the turn until the deadline")
    return (nil, "another engine was opening a session on this phone")
  }
  sessionTurnMs = turnMs
  // The restart of the phone's test daemons is done under the turn too: done outside it, it ended another engine's
  // request in flight (its testmanagerd stopped under it), and that engine, never answered, restarted them in turn for
  // the next one.
  if restartingDaemons { sessionLog("refused: the phone's test daemons restarted"); restartTestDaemons(); sessionRecoveries += 1 }
  sessionLog("open after waiting \(sessionTurnMs) ms")
  let opened = Date()
  var outcome = "failed"
  defer { sessionLog("open \(outcome) in \(ms(opened)) ms"); unlockSessionTurn() }
  guard let providerClass: AnyClass = NSClassFromString("XCUIDeviceRemoteDaemonConnectionProvider"),
        let sessionClass: AnyClass = NSClassFromString("XCUIDeviceRemoteAutomationSession") else { return (nil, "XCTest automation classes unavailable") }
  typealias ProviderFn = @convention(c) (AnyClass, Selector, AnyObject) -> Unmanaged<AnyObject>?
  let provider = unsafeBitCast(objcCall(providerClass, "connectionProviderForSimDevice:"), to: ProviderFn.self)(providerClass, NSSelectorFromString("connectionProviderForSimDevice:"), device)?.takeUnretainedValue()
  guard let provider else { return (nil, "no daemon connection provider") }
  let done = DispatchSemaphore(value: 0); var session: AnyObject?; var failure: String?
  let completion: @convention(block) (AnyObject?, NSError?) -> Void = { s, e in session = s; failure = e?.localizedDescription; done.signal() }
  typealias RequestFn = @convention(c) (AnyClass, Selector, AnyObject, AnyObject) -> Void
  let load = startLoadLog(), loadStarted = DispatchTime.now()
  defer { load?.process.terminate() }
  // testmanagerd switches app accessibility off as it stops (its log: AXDisableAccessibilityOnTermination): on again.
  if restartingDaemons { switchAccessibilityOn(device: device) }
  // A first request on a phone just booted, with no testmanagerd there yet, goes once app accessibility is switched on
  // and testmanagerd's log listens, each within its bound (waitsBeforeRequest, SessionWait.swift).
  if waitsBeforeRequest(restarting: restartingDaemons, daemonThere: phoneProcesses.pid(named: "testmanagerd") > 0,
                        young: phoneProcesses.youngerThan(seconds: youngPhoneSeconds)) {
    let gate = Date()
    if accessibilitySwitching.wait(deadline: deadline) == false { sessionLog("requested before app accessibility was switched on (\(Int(accessibilityWaitSeconds)) s from its start)") }
    if let load, !load.log.waitListening(until: min(loadStarted + logListenWaitSeconds, deadline)) { sessionLog("requested before testmanagerd's log listened (\(Int(logListenWaitSeconds)) s from its start)") }
    if ms(gate) >= 100 { sessionLog("requested after \(ms(gate)) ms for app accessibility's switch and testmanagerd's log") }
  }
  // The request's time on both clocks: a process's start time is the kernel's wall-clock time (DaemonStart).
  let requested = DispatchTime.now(), requestedWall = Date()
  unsafeBitCast(objcCall(sessionClass, "requestSessionWithDaemonConnectionProvider:completion:"), to: RequestFn.self)(sessionClass, NSSelectorFromString("requestSessionWithDaemonConnectionProvider:completion:"), provider, completion as AnyObject)
  let timeoutNanos = UInt64(timeout * 1e9)
  // A first request (no restart yet) leaves the time for one.
  let loadUntil = loadWaitEnd(deadline: deadline.uptimeNanoseconds, restartMayFollow: !restartingDaemons)
  var answered = false, state = SessionWait.waiting, noted = "", daemon: pid_t = 0, daemonState = Daemon.running
  let clock = RunClock(at: requested.uptimeNanoseconds)
  func since(_ t: UInt64) -> Int { Int((DispatchTime.now().uptimeNanoseconds - t) / 1_000_000) }
  while true {
    let now = DispatchTime.now().uptimeNanoseconds, heard = load?.log.snapshot, loadedAt = heard?.loadedAt, loading = heard?.loading ?? false
    clock.tick(at: now, clamped: phoneProcesses.clamped())
    // Which testmanagerd runs matters only once the first timeout has passed with accessibility not loaded; before,
    // the request is waited for whatever runs.
    if loadedAt == nil && now >= requested.uptimeNanoseconds + timeoutNanos {
      daemon = phoneProcesses.pid(named: "testmanagerd")
      daemonState = daemon <= 0 ? .none : (daemonStart(daemon, requested: requested.uptimeNanoseconds, requestedWall: requestedWall)
        ?? heard?.launchedAt).map { Daemon.started(at: $0) } ?? .running
    } else { daemon = 0; daemonState = .running }
    state = sessionWait(now: now, requestedAt: requested.uptimeNanoseconds, loadedAt: loadedAt, loading: loading, daemon: daemonState,
                        timeout: timeoutNanos, deadline: deadline.uptimeNanoseconds, loadUntil: loadUntil, ran: clock.ran(since:),
                        listenedAt: heard?.listenedAt)
    guard state == .waiting else { break }
    if loadedAt == nil && now >= requested.uptimeNanoseconds + timeoutNanos {
      var why = ""
      if loading { why = "testmanagerd pid \(daemon) is loading accessibility (its log)" }
      else if case .none = daemonState { why = "no testmanagerd yet: the phone's launchd is starting one for this request" }
      else if case .started(let at) = daemonState, at > requested.uptimeNanoseconds { why = "testmanagerd pid \(daemon) started \(Int((at - requested.uptimeNanoseconds) / 1_000_000)) ms after the request, for it" }
      if !why.isEmpty && why != noted { noted = why; sessionLog("no answer in \(since(requested.uptimeNanoseconds) / 1000) s: \(why), waited for") }
    }
    if done.wait(timeout: min(.now() + sessionPollSeconds, deadline)) == .success { answered = true; break }
  }
  let loadedAt = load?.log.loadedAt
  let loadedNote = loadedAt.map { "accessibility loaded \(Int((Int64($0) - Int64(requested.uptimeNanoseconds)) / 1_000_000)) ms after the request" } ?? "accessibility not loaded"
  if clock.clampedNanos > 0 { sessionLog("the phone was held at background priority for \(clock.clampedNanos / 1_000_000) ms of the wait: not counted as silence") }
  if let listening = load?.log.listeningAt { sessionLog("testmanagerd's log listening \(Int((Int64(listening) - Int64(requested.uptimeNanoseconds)) / 1_000_000)) ms after the request") }
  if !noted.isEmpty && answered { sessionLog("answered after the wait (\(loadedNote))") }
  if !answered {
    switch state {
    case .refused: sessionLog("refused: no answer \(Int(timeout)) s after accessibility was loaded (\(loadedNote))")
    case .nothingLoading:
      let started: String
      if case .started(let at) = daemonState, at > requested.uptimeNanoseconds { started = ", \(Int(timeout)) s after testmanagerd pid \(daemon) started for the request" }
      else { started = ": testmanagerd pid \(daemon) was there before it" }
      sessionLog("no answer in \(since(requested.uptimeNanoseconds)) ms and no load under way in testmanagerd's log\(load == nil ? " (its log could not be read)" : "")\(started)")
    case .loadTooLong: sessionLog("no answer in \(since(requested.uptimeNanoseconds)) ms, accessibility still not loaded\(daemon <= 0 ? " and no testmanagerd started" : ""): given up with the time for a restart left")
    default: sessionLog("no answer in \(since(requested.uptimeNanoseconds)) ms, testmanagerd's 120 s or the deadline (\(loadedNote))")
    }
    outcome = "timed out"; return (nil, "timed out creating the remote automation session")
  }
  guard let session else { return (nil, failure ?? "no session") }
  // An Objective-C NSError ** is autoreleasing: the callee hands back an object it does not own.
  typealias EnableFn = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool
  if session.responds(to: NSSelectorFromString("enableAutomationModeWithError:")) {
    var error: NSError?
    if !unsafeBitCast(objcCall(session, "enableAutomationModeWithError:"), to: EnableFn.self)(session, NSSelectorFromString("enableAutomationModeWithError:"), &error) { return (nil, "automation mode: \(error?.localizedDescription ?? "refused")") }
  }
  outcome = "ok"; sessionsOpened += 1
  markSessionOpen()
  return (session, nil)
}
/**
 * This phone's own processes: children of its launchd_sim, which is found by the UDID in its arguments and checked
 * again by them before each use (a pid can be reused). One fetcher, under a lock: the hook's thread and the main actor
 * both ask.
 */
final class PhoneProcesses: @unchecked Sendable {
  private let lock = NSLock()
  private let fetcher = FBProcessFetcher()
  private var launchd: pid_t = 0
  /** The pid of the phone's process of that name, or 0. */
  func pid(named name: String) -> pid_t {
    lock.lock(); defer { lock.unlock() }
    guard findLaunchd() > 0 else { return 0 }
    return max(0, fetcher.subprocess(of: launchd, withName: name))
  }
  /**
   * Whether the phone is held at background priority (`taskpolicy -b`, what NoMac's phone hosts do to a phone prepared
   * beside a live one): its launchd_sim's scheduling priority is then the kernel's throttled one, 4 (31 otherwise).
   * Unknown is not held.
   */
  func clamped() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard findLaunchd() > 0 else { return false }
    var info = proc_taskinfo()
    let size = Int32(MemoryLayout<proc_taskinfo>.size)
    return proc_pidinfo(launchd, PROC_PIDTASKINFO, 0, &info, size) == size && info.pti_priority <= throttledPriority
  }
  /**
   * Whether the phone booted less than `seconds` ago (its launchd_sim's start, from the kernel). Unknown is young: the
   * wait it allows is bounded.
   */
  func youngerThan(seconds: Double) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard findLaunchd() > 0 else { return true }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(launchd, PROC_PIDTBSDINFO, 0, &info, size) == size else { return true }
    let booted = Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1e6
    return Date().timeIntervalSince1970 - booted < seconds
  }
  /** The phone's launchd_sim, found again when the pid known no longer is it. Under the lock. */
  private func findLaunchd() -> pid_t {
    if launchd <= 0 || !(fetcher.processInfo(for: launchd)?.arguments.contains { $0.contains(udid) } ?? false) {
      launchd = fetcher.processes(withProcessName: "launchd_sim").first { $0.arguments.contains { $0.contains(udid) } }?.processIdentifier ?? 0
    }
    return launchd
  }
}
/** The kernel's scheduling priority for a process held at background (MAXPRI_THROTTLE). */
let throttledPriority: Int32 = 4
let phoneProcesses = PhoneProcesses()
/**
 * When a process started, on the uptime clock the session wait uses (DispatchTime): the kernel's record of its start
 * (wall-clock time, proc_pidinfo), carried over by the request's time on both clocks. nil when it cannot be read. A
 * process of the phone is one of the Mac's, run as this user, so it can be read.
 */
func daemonStart(_ pid: pid_t, requested: UInt64, requestedWall: Date) -> UInt64? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
  let startedWall = Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1e6
  let at = Double(requested) + (startedWall - requestedWall.timeIntervalSince1970) * 1e9
  return at <= 0 ? 0 : UInt64(at)
}
/** Ends the automation session so the phone accepts the next client's session (a session left open blocks them). */
/**
 * A phone takes a new automation session only a while after the last one closed: a second engine started as the
 * first one exited (0.8 s after its close) failed, and so did every session after it, for good (until a reboot;
 * measured on the M6). So opening and closing a session are done under a lock file per phone in the user's
 * temporary folder (held only for that, never for a session's life: sessions side by side are fine), which also
 * holds the time the last session closed; an engine opens only 2 s after it. simulator-use writes the time too
 * after an AXe read, which opens and closes a session of its own.
 */
let sessionGapSeconds = 2.0
var sessionLockFD: Int32 = -1
/** The user's temporary folder: $TMPDIR as simulator-use sees it (os.tmpdir()), else NSTemporaryDirectory(). */
func sessionFolder() -> String {
  if let tmp = ProcessInfo.processInfo.environment["TMPDIR"], !tmp.isEmpty { return tmp.hasSuffix("/") ? tmp : tmp + "/" }
  return NSTemporaryDirectory()
}
func sessionLockPath() -> String { sessionFolder() + "simulator-use-engine-\(udid).lock" }
/** One line per session event, beside the lock (what a stuck phone went through). */
func sessionLog(_ event: String) {
  let line = "\(String(format: "%.3f", Date().timeIntervalSince1970)) pid \(getpid()) \(event)\n"
  let path = sessionFolder() + "simulator-use-engine-\(udid).log"
  if let handle = FileHandle(forWritingAtPath: path) { handle.seekToEndOfFile(); handle.write(line.data(using: .utf8)!); handle.closeFile() }
  else { FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8), attributes: [.posixPermissions: 0o600]) }
}
/**
 * When the last session on this phone closed. The lock file holds that time, or, while an engine has a session open,
 * "open <pid>": an engine that ended without closing (killed, crashed) leaves that line, and its session then ended
 * with it at a time nobody wrote, so it is taken as just now and the full gap is waited. (Before, such an end left
 * the last clean close's time, the next engine opened at once, and the phone refused sessions from then on.)
 */
func lastSessionClose() -> Double {
  guard let text = try? String(contentsOfFile: sessionLockPath(), encoding: .utf8) else { return 0 }
  let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if line.hasPrefix("open ") {
    let holder = pid_t(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) ?? 0
    // Another engine that still runs holds its session open: nothing closed, so there is no gap to keep.
    if holder > 0 && holder != getpid() && kill(holder, 0) == 0 { return 0 }
    if holder == getpid() { return 0 }
    return Date().timeIntervalSince1970
  }
  return Double(line) ?? 0
}
/** Marks this engine as the holder of an open session (the turn's lock held). */
func markSessionOpen() { try? "open \(getpid())".write(toFile: sessionLockPath(), atomically: false, encoding: .utf8) }
/**
 * How long the engine's first read may spend on its session, from the request that needed it: the lock, the open,
 * a restart of the phone's test daemons and a second open, and loading accessibility. Below the 120 s after which
 * simulator-use ends an engine that answers nothing (src/engine/native.ts, HUNG_MS). It is also the longest any engine
 * holds the lock below, so it is how long one waits for it.
 */
let sessionBudget: TimeInterval = 100
/** The lock for one open or close, waited for until the deadline; whether it was taken. */
@discardableResult
func lockSessionTurn(until deadline: DispatchTime) -> Bool {
  if sessionLockFD < 0 { sessionLockFD = open(sessionLockPath(), O_CREAT | O_RDWR | O_CLOEXEC, 0o600) }
  guard sessionLockFD >= 0 else { return true }
  while flock(sessionLockFD, LOCK_EX | LOCK_NB) != 0 {
    if DispatchTime.now() >= deadline { return false }
    usleep(50_000)
  }
  return true
}
func unlockSessionTurn() { if sessionLockFD >= 0 { flock(sessionLockFD, LOCK_UN) } }
/** Before a session is opened: the lock, then the gap since the last close. The ms waited, or nil without the lock. */
func takeSessionTurn(deadline: DispatchTime) -> Int? {
  let start = Date()
  guard lockSessionTurn(until: deadline) else { return nil }
  let wait = lastSessionClose() + sessionGapSeconds - Date().timeIntervalSince1970
  if wait > 0 { usleep(UInt32(min(wait, sessionGapSeconds) * 1_000_000)) }
  return ms(start)
}
func closeSession() {
  guard let session = automationSession else { return }
  automationSession = nil
  // Another engine may hold the turn for a whole open (sessionBudget); the close goes ahead only after it.
  lockSessionTurn(until: .now() + sessionBudget)
  sessionLog("close")
  if session.responds(to: NSSelectorFromString("invalidate")) { _ = session.perform(NSSelectorFromString("invalidate")) }
  // The invalidation is a message to the phone's testmanagerd: give it time to arrive before the process ends. Off
  // the main thread (a signal while a read holds it) there is no run loop to turn: the time alone.
  if Thread.isMainThread { RunLoop.current.run(until: Date().addingTimeInterval(0.8)) } else { Thread.sleep(forTimeInterval: 0.8) }
  try? String(Date().timeIntervalSince1970).write(toFile: sessionLockPath(), atomically: false, encoding: .utf8)
  unlockSessionTurn()
}
/** Sessions opened again in place of one that had died (its phone's test daemon restarted, or was ended for memory). */
var sessionsReopened = 0
func loadAccessibility(_ session: AnyObject, timeout: Double) -> String? {
  let done = DispatchSemaphore(value: 0); var ok = false; var failure: String?
  let reply: @convention(block) (Bool, NSError?) -> Void = { loaded, e in ok = loaded; failure = e?.localizedDescription; done.signal() }
  typealias LoadFn = @convention(c) (AnyObject, Selector, Double, AnyObject) -> Void
  unsafeBitCast(objcCall(session, "loadAccessibilityWithTimeout:reply:"), to: LoadFn.self)(session, NSSelectorFromString("loadAccessibilityWithTimeout:reply:"), timeout, reply as AnyObject)
  if done.wait(timeout: .now() + timeout + 1) == .timedOut { return "timed out loading accessibility" }
  return ok ? nil : (failure ?? "accessibility load refused")
}
/** +[FBSimulatorControlFrameworkLoader bootstrapAccessibilityForSimulatorDevice:timeout:logger:error:]; its NSError ** is autoreleasing. */
typealias BootstrapIMP = @convention(c) (AnyClass, Selector, AnyObject, Double, AnyObject?, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool
var lastBootstrapError: String?
/**
 * The axe path's reload: FBSimulatorControl's own short-lived session (open, load accessibility, close), taken under
 * the lock and after the gap our sessions keep (a session opened too soon after another closed is refused, and so is
 * every later one), with its close time written for the next.
 */
func shortLivedBootstrap(_ original: BootstrapIMP, _ klass: AnyClass, _ sel: Selector, _ device: AnyObject, _ timeout: Double, _ logger: AnyObject?,
                         _ errorOut: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool {
  bootstrapCount += 1
  sessionTurnMs = takeSessionTurn(deadline: .now() + sessionBudget) ?? Int(sessionBudget * 1000)
  let opened = Date()
  var error: NSError?
  let ok = original(klass, sel, device, timeout, logger, &error)
  sessionLog("short-lived session \(ok ? "ok" : "failed") in \(ms(opened)) ms after waiting \(sessionTurnMs) ms")
  try? String(Date().timeIntervalSince1970).write(toFile: sessionLockPath(), atomically: false, encoding: .utf8)
  unlockSessionTurn()
  if ok { sessionsOpened += 1 } else { lastBootstrapError = error?.localizedDescription ?? "accessibility load refused"; errorOut?.pointee = error }
  return ok
}
func installPersistentBootstrap() {
  let cls: AnyClass = FBSimulatorControlFrameworkLoader.self
  let sel = NSSelectorFromString("bootstrapAccessibilityForSimulatorDevice:timeout:logger:error:")
  guard let method = class_getClassMethod(cls, sel) else { return }
  let original = unsafeBitCast(method_getImplementation(method), to: BootstrapIMP.self)
  let block: @convention(block) (AnyClass, AnyObject, Double, AnyObject?, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool = { klass, device, timeout, logger, errorOut in
    if skipBootstrap { return true }
    if readPath == .axe { return shortLivedBootstrap(original, klass, sel, device, timeout, logger, errorOut) }
    if let session = automationSession {
      if !forceBootstrap { return true }
      bootstrapCount += 1; forceBootstrap = false
      guard let failure = loadAccessibility(session, timeout: 10) else { return true }
      // The kept session does not load accessibility any more: its test daemon in the phone went (restarted by
      // another engine's recovery, ended for memory, a UI test run). Kept, it stays dead for the engine's life, and
      // every app launched from then on reads empty until the phone is rebooted. So it is closed (its close time
      // written, the gap kept) and a new one opened below, in this same request.
      sessionLog("the kept session no longer loads accessibility (\(failure)): closing it and opening another")
      closeSession()
      sessionsReopened += 1
    }
    // The first time: the framework's own bootstrap loads the XCTest frameworks; then our session stays open. All of
    // it within sessionBudget of now.
    let deadline = DispatchTime.now() + sessionBudget
    func left() -> Double { Double(Int64(deadline.uptimeNanoseconds) - Int64(DispatchTime.now().uptimeNanoseconds)) / 1e9 }
    bootstrapCount += 1
    // The XCTest frameworks the session needs, loaded the framework's way, without its throwaway session.
    var loaded = false
    if let loader = (FBSimulatorControlFrameworkLoader.self as AnyObject).perform(NSSelectorFromString("accessibilityAutomationFrameworks"))?.takeUnretainedValue() as? FBSimulatorControlFrameworkLoader {
      loaded = (try? loader.loadPrivateFrameworks(logger as? FBControlCoreLogger)) != nil
    }
    if !loaded { _ = original(klass, sel, device, max(timeout, 20), logger, errorOut) }
    var (session, failure) = openSession(device: device, timeout: 12, deadline: deadline)
    // A phone that refuses sessions (after one opened too soon after another closed it refuses them for good) takes
    // them again once its test daemons are restarted: no reboot, the apps stay as they are (measured). Only with
    // time left for the restart and a second request.
    if session == nil && timeForRestart(secondsLeft: left()) {
      (session, failure) = openSession(device: device, timeout: 20, deadline: deadline, restartingDaemons: true)
    }
    guard let session else { lastBootstrapError = failure; return false }
    if let failure = loadAccessibility(session, timeout: max(1, min(10, left()))) { lastBootstrapError = failure }
    automationSession = session; forceBootstrap = false
    return true
  }
  let hook = imp_implementationWithBlock(block)
  method_setImplementation(method, hook)
  hookInstalled = class_getClassMethod(cls, sel).map(method_getImplementation) == hook
}
func nodeCount(_ tree: Any) -> Int {
  if let list = tree as? [Any] { return list.reduce(0) { $0 + nodeCount($1) } }
  guard let n = tree as? [String: Any] else { return 0 }
  return 1 + ((n["children"] as? [Any]).map(nodeCount) ?? 0)
}
/**
 * A number from FBSimulatorControl's dictionaries. A pid comes as a pid_t (Int32) inside Any, which `as? Int`
 * does not take: every pid read that way was nil.
 */
func intValue(_ value: Any?) -> Int? {
  if let i = value as? Int { return i }
  if let i = value as? Int32 { return Int(i) }
  if let n = value as? NSNumber { return n.intValue }
  return nil
}
/** A number as FBSimulatorControl's dictionaries hold it: a Double, or an NSNumber that `as? Double` does not always take. */
func number(_ value: Any?) -> Double? {
  if let d = value as? Double { return d }
  if let n = value as? NSNumber { return n.doubleValue }
  if let f = value as? CGFloat { return Double(f) }
  return nil
}
/** An element's frame: FBSimulatorControl's "frame" dictionary, or its "AXFrame" string. */
func frameOf(_ node: [String: Any]) -> CGRect? {
  if let f = node["frame"] as? [String: Any], let x = number(f["x"]), let y = number(f["y"]), let w = number(f["width"]), let h = number(f["height"]) {
    return CGRect(x: x, y: y, width: w, height: h)
  }
  if let text = node["AXFrame"] as? String { return NSRectFromString(text) }
  return nil
}
// MARK: An app in a window

/**
 * Where the frontmost app's points are on the screen. An iPhone app on an iPad runs in a window that iPadOS moves and
 * scales (an iPad Air on iOS 26.5: from x 79, 1.77 times; App Review's iPad Air on iPadOS 27: from x 204, unscaled),
 * while accessibility gives the app's frames in its own points, from its own top left: a tap at those numbers lands
 * beside the app, or on another of its controls (October 30, 2026, reproducing an App Review rejection). A hit test
 * takes screen points, so the window is measured by asking which app is at a point: its left and right edges give the
 * scale and x, its top or bottom gives y (the status bar hides a window's top from hit tests), and of those candidates
 * the one the app's own elements answer to is kept. The tree's frames are then screen points, like taps, swipes and
 * screenshots, and its root says where the window is (placement) and how big the screen is (display).
 */
struct Placement: Equatable {
  var x: Double, y: Double, scale: Double
  static let identity = Placement(x: 0, y: 0, scale: 1)
  /** Within a point and a percent of none: an app's own rounding, not a window. */
  var isIdentity: Bool { abs(x) < 1.5 && abs(y) < 1.5 && abs(scale - 1) < 0.01 }
  func rect(_ r: CGRect) -> CGRect { CGRect(x: x + r.minX * scale, y: y + r.minY * scale, width: r.width * scale, height: r.height * scale) }
}
/** The screen in use in points, as its interface is drawn (Screens.swift's activate sets these three). */
var display = CGSize.zero
/** Pixels per point of the screen buffer. */
var pixelScale: CGFloat = 1
/** The screen in use: its buffer's pixels, scale and the guest's turn of it. */
var screenGeometry = ScreenGeometry(native: .zero, scale: 1, rotation: 0)
/** A box of the screen buffer's pixels in the interface's points (turned with it on a foldable's turned screen). */
func pointsBox(_ box: CGRect) -> CGRect {
  screenGeometry.rotation == 0 ? CGRect(x: box.minX / pixelScale, y: box.minY / pixelScale, width: box.width / pixelScale, height: box.height / pixelScale)
    : screenGeometry.logicalRect(nativePixels: box)
}
/** The last measurement: the app (pid) whose root had this frame, where it was (nil: not found), and when. */
var lastPlacement: (pid: Int, app: CGRect, placement: Placement?, at: Date)? = nil
/** A window that could not be measured is not measured again for this long (each try costs about a second). */
let unplacedRetry: TimeInterval = 10

/** A node and everything under it with its frames moved and scaled onto the screen. */
func placed(_ node: [String: Any], _ p: Placement) -> [String: Any] {
  var n = node
  if let f = node["frame"] as? [String: Any], let r = frameOf(["frame": f]) {
    let m = p.rect(r); n["frame"] = ["x": m.minX, "y": m.minY, "width": m.width, "height": m.height]
  }
  if let text = node["AXFrame"] as? String { n["AXFrame"] = NSStringFromRect(p.rect(NSRectFromString(text))) }
  if let kids = node["children"] as? [[String: Any]] { n["children"] = kids.map { placed($0, p) } }
  return n
}
/** The element at a screen point as its app reports it (in the app's own points), or nil where there is none. */
@MainActor
func rawHit(_ simulator: FBSimulator, _ x: Double, _ y: Double) async -> [String: Any]? {
  guard let element = try? await pointElement(simulator, CGPoint(x: x, y: y)) else { return nil }
  defer { element.close() }
  return (try? element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: false, keys: outputKeys)).elements).map(withDefaults) as? [String: Any]
}
/** A hit at a screen point, in screen points: inside a measured window its frames are the app's own, and are placed. */
func onScreen(_ found: Any, at point: CGPoint) -> Any {
  guard let last = lastPlacement, let p = last.placement, !p.isIdentity, p.rect(last.app).insetBy(dx: -1, dy: -1).contains(point) else { return found }
  if let list = found as? [[String: Any]] { return list.map { placed($0, p) } }
  if let one = found as? [String: Any] { return placed(one, p) }
  return found
}
/** Up to four of the app's labelled leaves, spread from top to bottom: what a candidate placement is checked against. */
func probes(_ root: [String: Any], app: CGRect) -> [(label: String, frame: CGRect)] {
  var found: [(label: String, frame: CGRect)] = []
  func walk(_ n: [String: Any]) {
    let kids = (n["children"] as? [[String: Any]]) ?? []
    if kids.isEmpty, let label = n["AXLabel"] as? String, !label.isEmpty, let f = frameOf(n), f.width >= 4, f.height >= 4,
       f.width < app.width * 0.8, f.height < app.height * 0.5, app.contains(CGPoint(x: f.midX, y: f.midY)) { found.append((label, f)) }
    kids.forEach(walk)
  }
  walk(root)
  found.sort { $0.frame.midY < $1.frame.midY }
  guard found.count > 4 else { return found }
  return [0, found.count / 3, 2 * found.count / 3, found.count - 1].map { found[$0] }
}
/** Whether a hit is the probe: the same label, overlapping it (a hit is the deepest element, which a leaf is). */
func isProbe(_ hit: [String: Any]?, _ probe: (label: String, frame: CGRect)) -> Bool {
  guard let hit, (hit["AXLabel"] as? String) == probe.label, let f = frameOf(hit) else { return false }
  return f.intersects(probe.frame)
}
@MainActor
func measurePlacement(_ simulator: FBSimulator, pid: Int, app: CGRect, root: [String: Any]) async -> Placement? {
  let W = Double(display.width), H = Double(display.height)
  guard W > 0, H > 0, app.width > 0, app.height > 0 else { return nil }
  // About 60 hit tests, 10 to 25 ms each once a phone is warm; right after a boot one can take seconds, so the
  // measurement gives up after 4 s (the read goes on unplaced, said so, and the next read after unplacedRetry tries again).
  let deadline = Date().addingTimeInterval(4)
  var late: Bool { Date() > deadline }
  func inside(_ x: Double, _ y: Double) async -> Bool {
    if late { return false }
    return intValue(await rawHit(simulator, x, y)?["pid"]) == pid
  }
  // A point in the window: the screen's middle, else one of a grid.
  var start: (x: Double, y: Double)? = nil
  var grid: [(x: Double, y: Double)] = []
  for gy in [0.5, 0.3, 0.7, 0.15, 0.85] { for gx in [0.5, 0.3, 0.7, 0.15, 0.85] { grid.append((W * gx, H * gy)) } }
  for p in grid where start == nil && !late { if await inside(p.x, p.y) { start = p } }
  guard let s = start, !late else { return nil }
  /** Where the window ends between a point in it (from) and the screen's edge (to), to a quarter of a point. */
  func edge(_ from: Double, _ to: Double, _ at: (Double) -> (x: Double, y: Double)) async -> Double {
    if await inside(at(to).x, at(to).y) { return to }
    var a = from, b = to
    while abs(b - a) > 0.25 { let m = (a + b) / 2; if await inside(at(m).x, at(m).y) { a = m } else { b = m } }
    return (a + b) / 2
  }
  let left = await edge(s.x, 0) { ($0, s.y) }, right = await edge(s.x, W) { ($0, s.y) }
  let top = await edge(s.y, 0) { (s.x, $0) }, bottom = await edge(s.y, H) { (s.x, $0) }
  let across = (right - left) / Double(app.width), down = (bottom - top) / Double(app.height)
  let candidates = [
    Placement(x: left - across * Double(app.minX), y: bottom - across * Double(app.maxY), scale: across),
    Placement(x: left - across * Double(app.minX), y: top - across * Double(app.minY), scale: across),
    Placement(x: left - down * Double(app.minX), y: top - down * Double(app.minY), scale: down),
    Placement(x: right - down * Double(app.maxX), y: bottom - down * Double(app.maxY), scale: down),
    Placement.identity,
  ].filter { $0.scale > 0.2 && $0.scale < 5 }
  if late { return nil }
  let checks = probes(root, app: app)
  // Nothing labelled to check against: the window's sides and bottom (its top may be under the status bar).
  if checks.isEmpty { return candidates.first }
  var best: (placement: Placement, score: Int)? = nil
  for candidate in candidates {
    var score = 0
    for probe in checks {
      let m = candidate.rect(probe.frame)
      guard m.midX > 0, m.midX < W, m.midY > 0, m.midY < H else { continue }
      if isProbe(await rawHit(simulator, Double(m.midX), Double(m.midY)), probe) { score += 1 }
    }
    if score > (best?.score ?? 0) { best = (candidate, score) }
    if score == checks.count || late { break }
  }
  return best?.placement
}
/** Whether the app is still where it was measured: one of its labelled leaves, or else its middle, answers there. */
@MainActor
func stillPlaced(_ simulator: FBSimulator, _ p: Placement, pid: Int, app: CGRect, root: [String: Any]) async -> Bool {
  if let probe = probes(root, app: app).first {
    let m = p.rect(probe.frame)
    return isProbe(await rawHit(simulator, Double(m.midX), Double(m.midY)), probe)
  }
  let m = p.rect(app)
  return intValue(await rawHit(simulator, Double(m.midX), Double(m.midY))?["pid"]) == pid
}
/**
 * On a screen the guest turns (a Duo's inner screen), the app's root element reports the panel's own, unturned size
 * (669x951 against the 951x669 its windows and every element below them use, measured on iOS 27.2): it fills the
 * screen, and is given the screen's size as drawn.
 */
func turnedRoot(_ tree: Any) -> Any {
  guard screenGeometry.turned, var roots = tree as? [[String: Any]], let root = roots.first, let app = frameOf(root),
        abs(app.minX) < 1, abs(app.minY) < 1, abs(app.width - display.height) < 1, abs(app.height - display.width) < 1 else { return tree }
  let drawn = CGRect(origin: .zero, size: display)
  if root["frame"] != nil { roots[0]["frame"] = ["x": 0.0, "y": 0.0, "width": Double(drawn.width), "height": Double(drawn.height)] }
  if root["AXFrame"] != nil { roots[0]["AXFrame"] = NSStringFromRect(drawn) }
  return roots
}
/** The tree in screen points (see Placement). An app that fills the screen, as every app on an iPhone does, is as read. */
@MainActor
func onScreen(_ simulator: FBSimulator, _ given: Any) async -> Any {
  let tree = turnedRoot(given)
  guard var roots = tree as? [[String: Any]], let root = roots.first, let app = frameOf(root), let pid = intValue(root["pid"]), display.width > 0,
        !(abs(app.minX) < 1 && abs(app.minY) < 1 && abs(app.width - display.width) < 1 && abs(app.height - display.height) < 1) else { return tree }
  var placement: Placement? = nil
  if let last = lastPlacement, last.pid == pid, last.app == app,
     last.placement == nil ? Date().timeIntervalSince(last.at) < unplacedRetry : await stillPlaced(simulator, last.placement!, pid: pid, app: app, root: root) {
    placement = last.placement
  } else {
    placement = await measurePlacement(simulator, pid: pid, app: app, root: root)
    lastPlacement = (pid, app, placement, Date())
  }
  let screen: [String: Any] = ["width": Double(display.width), "height": Double(display.height)]
  guard let p = placement else {
    roots[0]["placement"] = "unknown"; roots[0]["display"] = screen
    return roots
  }
  if p.isIdentity { return tree }
  // The root's children are the app's windows. One the size of the screen is the iPad's own (its keyboard, across
  // the screen): already in screen points (iPadOS 27, October 30, 2026), so it is left as it is.
  roots = roots.map { root in
    var top = placed(root.filter { $0.key != "children" }, p)
    if let windows = root["children"] as? [[String: Any]] {
      top["children"] = windows.map { w in
        guard let f = frameOf(w), abs(f.width - display.width) < 1, abs(f.height - display.height) < 1 else { return placed(w, p) }
        return w
      }
    }
    return top
  }
  roots[0]["placement"] = ["x": p.x, "y": p.y, "scale": p.scale]; roots[0]["display"] = screen
  return roots
}

/** Some text in the element or under it, scroll bars aside. */
func hasText(_ node: [String: Any]) -> Bool {
  if (node["role"] as? String) == "AXSlider" { return false }
  for key in ["AXLabel", "AXValue"] {
    if let text = node[key] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
  }
  return ((node["children"] as? [[String: Any]]) ?? []).contains(where: hasText)
}
/** A web view's empty area: a scroll or web area of 15% of the screen or more with no text under it. */
func isEmptyWebArea(_ node: [String: Any], screen: CGRect) -> CGRect? {
  guard let role = node["role"] as? String, role == "AXScrollArea" || role == "AXWebArea", let frame = frameOf(node)?.intersection(screen),
        !frame.isNull, frame.width * frame.height >= screen.width * screen.height * 0.15, !hasText(node) else { return nil }
  return frame
}
/**
 * The page's elements in one area, read point by point: five columns swept from the top, each point's element kept
 * and jumped past, points inside an element already found skipped. Elements as big as half the area (the page's
 * own containers) say nothing and are passed in 20-point steps (a line of text is at least 20 points tall).
 */
@MainActor
func webScan(_ simulator: FBSimulator, region: CGRect, deadline: Date, appPid: Int) async -> (elements: [[String: Any]], reads: Int, complete: Bool, web: Bool) {
  var found: [[String: Any]] = [], seen = Set<String>(), covered: [CGRect] = [], reads = 0
  // Any element from another process (the web process) shows the area is a page. 24 reads with none (a map, a
  // game, custom drawing, an empty list): not a page, and the sweep stops.
  var foreign = false
  let area = region.width * region.height
  func ordered() -> [[String: Any]] {
    found.sorted { a, b in
      let fa = frameOf(a) ?? .zero, fb = frameOf(b) ?? .zero
      return fa.minY != fb.minY ? fa.minY < fb.minY : fa.minX < fb.minX
    }
  }
  for share in [0.1, 0.5, 0.9, 0.3, 0.7] as [CGFloat] {
    let x = region.minX + region.width * share
    var y = region.minY + 4
    while y < region.maxY - 2 {
      if Date() > deadline || reads >= 600 { return (ordered(), reads, false, true) }
      if reads >= 24 && !foreign { return ([], reads, true, false) }
      if let inside = covered.first(where: { $0.minX <= x && x <= $0.maxX && $0.minY <= y && y <= $0.maxY }) { y = inside.maxY + 1; continue }
      reads += 1
      let hit = (await rawHit(simulator, x, y)).map { onScreen($0, at: CGPoint(x: x, y: y)) } as? [String: Any]
      if let pid = intValue(hit?["pid"]), pid != appPid, pid > 0 { foreign = true }
      guard let node = hit, let frame = frameOf(node), frame.width > 0, frame.height > 0, frame.width * frame.height < area * 0.5 else { y += 20; continue }
      // The app's own elements over the page (a keyboard's bar, a toolbar) are in its tree already: jump past them.
      let fromApp = intValue(node["pid"]) == appPid
      let key = "\(node["role"] ?? "")|\(node["AXLabel"] ?? "")|\(node["AXValue"] ?? "")|\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height))"
      if !fromApp && seen.insert(key).inserted {
        var element = node
        element["found_by"] = "point_scan"
        if element["children"] == nil { element["children"] = [Any]() }
        found.append(element)
      }
      covered.append(frame)
      y = max(y + 4, frame.maxY + 1)
    }
  }
  // A small control left of its text (a checkbox, a radio button, an icon) falls between the columns: one point
  // read just left of each text found.
  for text in found where (text["role"] as? String) == "AXStaticText" {
    guard let frame = frameOf(text), frame.minX - 6 > region.minX else { continue }
    let point = CGPoint(x: frame.minX - 6, y: frame.midY)
    if covered.contains(where: { $0.contains(point) }) { continue }
    if Date() > deadline || reads >= 600 { return (ordered(), reads, false, true) }
    reads += 1
    let hit = (await rawHit(simulator, point.x, point.y)).map { onScreen($0, at: point) } as? [String: Any]
    guard let node = hit, let f = frameOf(node), f.width > 0, f.height > 0, f.width * f.height < area * 0.5, intValue(node["pid"]) != appPid else { continue }
    let key = "\(node["role"] ?? "")|\(node["AXLabel"] ?? "")|\(node["AXValue"] ?? "")|\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height))"
    if seen.insert(key).inserted {
      var element = node
      element["found_by"] = "point_scan"
      if element["children"] == nil { element["children"] = [Any]() }
      found.append(element)
    }
    covered.append(f)
  }
  return (ordered(), reads, true, true)
}
/** The tree with each empty web area filled from webScan (or from the last scan, while the screen is unchanged). */
@MainActor
func withWebContent(_ simulator: FBSimulator, _ tree: Any) async -> Any {
  guard var roots = tree as? [[String: Any]], let screen = roots.first.flatMap(frameOf), screen.width > 0 else { return tree }
  let start = Date(), deadline = start.addingTimeInterval(webBudget), seedBefore = screenWatcher?.currentSeed()
  let appPid = intValue(roots.first?["pid"]) ?? -1
  var areas = 0, reads = 0, complete = true, cached = false, count = 0, pages = 0
  func fill(_ node: [String: Any]) async -> [String: Any] {
    if let region = isEmptyWebArea(node, screen: screen) {
      areas += 1
      let seed = screenWatcher?.currentSeed()
      var elements: [[String: Any]]
      if let last = lastWebScan, let seed, last.seed == seed, last.region == region {
        elements = last.elements; cached = true
      } else {
        let scan = await webScan(simulator, region: region, deadline: deadline, appPid: appPid)
        elements = scan.elements; reads += scan.reads; complete = complete && scan.complete; if scan.web { pages += 1 }
        // Only a whole scan of pixels that did not change while it ran is kept for the next read.
        if let seed, scan.complete, screenWatcher?.currentSeed() == seed { lastWebScan = (seed, region, elements) } else { lastWebScan = nil }
      }
      count += elements.count
      var filled = node
      filled["children"] = ((node["children"] as? [Any]) ?? []) + elements
      return filled
    }
    guard let children = node["children"] as? [[String: Any]], !children.isEmpty else { return node }
    var filled = node, out: [[String: Any]] = []
    for child in children { out.append(await fill(child)) }
    filled["children"] = out
    return filled
  }
  for i in roots.indices { roots[i] = await fill(roots[i]) }
  if areas > 0 {
    lastReadReport["web_scan"] = ["areas": areas, "pages": pages, "reads": reads, "elements": count, "complete": complete, "cached": cached, "ms": ms(start),
      "seed_before": seedBefore.map { Int($0) } ?? -1, "seed_after": screenWatcher?.currentSeed().map { Int($0) } ?? -1]
  }
  return roots
}
/** One accessibility read of the frontmost app, with the options above; its time goes to lastSerializeMs. */
@MainActor
func serializeFrontmost(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool, reload: Bool = false) async throws -> Any {
  let start = Date()
  let element = try await frontmostElement(simulator, reload: reload)
  defer { element.close() }
  let response = try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: nested, keys: keys, enableProfiling: readProfile,
    collectFrameCoverage: readRemote != nil, remoteContentOptions: readRemote))
  lastSerializeMs.append(ms(start))
  if let coverage = response.frameCoverage { lastReadReport["frame_coverage"] = coverage }
  if let added = response.additionalFrameCoverage { lastReadReport["remote_coverage"] = added }
  if let profile = response.profilingData { lastReadReport["profile"] = profile.asDictionary() }
  return withDefaults(response.elements)
}
/** remote: true, or {step, max_points, region: [x, y, width, height]} in points. */
func remoteOptions(_ value: Any?) -> FBAccessibilityRemoteContentOptions? {
  if let on = value as? Bool { return on ? FBAccessibilityRemoteContentOptions() : nil }
  guard let o = value as? [String: Any] else { return nil }
  var region = CGRect.null
  if let r = o["region"] as? [Double], r.count == 4 { region = CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) }
  return FBAccessibilityRemoteContentOptions(gridStepSize: CGFloat(o["step"] as? Double ?? 50), region: region, maxPoints: UInt(o["max_points"] as? Int ?? 0))
}
@MainActor
func readFrontmost(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool = true) async throws -> Any {
  // A foldable whose screen in use changed while it was read: that read was of the screen that went dark, so the
  // screen in use is read instead (twice at most).
  for attempt in 0..<3 {
    let seen = screens?.generation ?? 0
    let tree = try await readFrontmostOnce(simulator, keys: keys, nested: nested)
    guard let screens, screens.foldable, attempt < 2 else { return tree }
    if screens.changing { await screens.waitUntilSteady() }
    guard screens.generation != seen else { return tree }
    screens.apply()
    lastReadReport["screen_changed"] = true
  }
  return []
}
/** Where a traced request's reads spent their time: each read's serializes in ms, "r" before one that reloaded accessibility, and what followed. */
var readPhases: [String] = []
@MainActor
func readFrontmostOnce(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool = true) async throws -> Any {
  var reloaded = false, reloadedAfterError = false
  lastSerializeMs = []
  let readStart = Date()
  defer { if readPhases.count < 40 { readPhases.append("\(lastSerializeMs.map(String.init).joined(separator: "+"))\(reloaded ? " reloaded" : "")\(reloadedAfterError ? " reloaded-after-error" : "") =\(ms(readStart))") } }
  for attempt in 0..<2 {
    do {
      // The second attempt loads accessibility first (an app launched since the last load reads empty).
      var tree = try await serializeFrontmost(simulator, keys: keys, nested: nested, reload: attempt > 0)
      if attempt == 0 && isEmptyApp(tree) { reloaded = true; continue }
      // After accessibility was reloaded (an app that read empty), its elements fill in over a moment: read again
      // until two reads agree, up to 2 s. A newly opened app is read again by simulator-use (opening() in
      // src/look/read.ts); the pid comparison that once did it here never fired (pids came back nil), and every
      // measurement of the day was made without it, so it stays off.
      lastReadStable = !reloaded && !reloadedAfterError
      if reloaded {
        let start = Date()
        while Date().timeIntervalSince(start) < 2 {
          try? await Task.sleep(nanoseconds: 100_000_000)
          let next = try await serializeFrontmost(simulator, keys: keys, nested: nested)
          let same = signature(next) == signature(tree)
          tree = next
          // Two equal reads of a nearly empty app may be its shell before the content. They are the app once it has
          // some size (12 elements), or once the screen itself has held still for 0.2 s: what is still to come would
          // be drawn. (A screen of under 12 elements, a sign-in form, waited the whole 2 s on every launch before.)
          let still = (writeClock?.sinceSignificantWrite() ?? 0) >= 0.2
          if same && !isEmptyApp(tree) && (nodeCount(tree) >= 12 || still) { lastReadStable = true; break }
        }
      }
      lastFrontPid = intValue((tree as? [[String: Any]])?.first?["pid"]) ?? -1
      tree = await onScreen(simulator, tree)
      if webScanOn { tree = await withWebContent(simulator, tree) }
      lastTreeSignature = signature(tree)
      return tree
    } catch {
      if attempt == 0 && String(describing: error).contains("No translation object") { reloadedAfterError = true; continue }
      throw error
    }
  }
  return []
}
/**
 * A coordinate of an input request: in points (key), or as a fraction of the screen in use (nkey, 0 to 1, clamped),
 * so a caller needs no size (the live view's taps).
 */
func coordinate(_ req: [String: Any], _ key: String, _ normalized: String, along size: CGFloat) -> Double {
  if let n = number(req[normalized]) { return min(max(n, 0), 1) * Double(size) }
  return number(req[key]) ?? 0
}
/**
 * An input as one HID event: {"op": "tap", x, y}, {"op": "swipe", x1, y1, x2, y2, delta, duration}, {"op": "drag",
 * x1, y1, x2, y2, duration, steps, hold}, or {"op": "steps", steps: [...]}, simulator-use's input batch as one
 * composite: [{"tap":[x,y]}, {"sleep":s}, {"key":code}, {"combo":{"mods":[codes],"key":code}}, {"type":"text"},
 * {"touch":[x,y],"hold":s}]. tap takes nx, ny and swipe and drag nx1, ny1, nx2, ny2 instead: fractions of the screen
 * in use (the ready line's "input": ["points", "normalized"]).
 */
func inputEvent(_ req: [String: Any]) throws -> FBSimulatorHIDEvent {
  let w = display.width, h = display.height
  switch req["op"] as? String ?? "" {
  case "tap":
    return .tapAt(x: coordinate(req, "x", "nx", along: w), y: coordinate(req, "y", "ny", along: h))
  case "swipe":
    let x1 = coordinate(req, "x1", "nx1", along: w), y1 = coordinate(req, "y1", "ny1", along: h), x2 = coordinate(req, "x2", "nx2", along: w), y2 = coordinate(req, "y2", "ny2", along: h)
    return .swipe(x1, yStart: y1, xEnd: x2, yEnd: y2, delta: req["delta"] as? Double ?? 10, duration: req["duration"] as? Double ?? 0.3)
  case "drag":
    // A finger put down, moved in steps and lifted (sliders, reordering); a swipe is a quick drag. up: false leaves the
    // finger down at the end, and down: false moves a finger left down so from where it is (x1, y1): a slider is set
    // by a finger held on it, moved while the slider is read (ui-act.ts). steps: 0 with down: false is the lift alone, an
    // up with no move before it: where no finger is down (a first move that never went out) it touches nothing, where a
    // move and an up would tap.
    let x1 = coordinate(req, "x1", "nx1", along: w), y1 = coordinate(req, "y1", "ny1", along: h), x2 = coordinate(req, "x2", "nx2", along: w), y2 = coordinate(req, "y2", "ny2", along: h)
    let down = req["down"] as? Bool ?? true
    let duration = req["duration"] as? Double ?? 0.6, n = max(down ? 1 : 0, Int(req["steps"] as? Double ?? 20))
    var events: [FBSimulatorHIDEvent] = down ? [.touch(direction: .down, x: x1, y: y1), .delay(req["hold"] as? Double ?? 0.05)] : []
    // ease "out": the finger slows to a stop over the way (a cubic), as a hand does that places content, where an even
    // pace ends at full speed.
    let easeOut = (req["ease"] as? String) == "out"
    for i in stride(from: 1, through: n, by: 1) {
      let t = Double(i) / Double(n), f = easeOut ? 1 - pow(1 - t, 3) : t
      events += [.delay(duration / Double(n)), .touch(direction: .down, x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f)]
    }
    if req["up"] as? Bool ?? true {
      // rest: the finger held where it stopped before it lifts, so the content stops with it. A finger lifted while
      // moving flings the content, which then coasts on its own (1.7 s after a 1.2 s drag of a list, November 22,
      // 2026); the same point sent again after the rest is the sample that tells iOS the finger stood still.
      if let rest = req["rest"] as? Double, rest > 0 {
        for _ in 0..<max(1, Int((rest / 0.03).rounded())) { events += [.delay(0.03), .touch(direction: .down, x: x2, y: y2)] }
        events.append(.delay(0.016))
      }
      events.append(.touch(direction: .up, x: x2, y: y2))
    }
    return .composite(events)
  case "steps":
    var events: [FBSimulatorHIDEvent] = []
    for step in (req["steps"] as? [[String: Any]]) ?? [] {
      if let p = step["tap"] as? [Double], p.count == 2 { events.append(.tapAt(x: p[0], y: p[1])) }
      else if let s = step["sleep"] as? Double { events.append(.delay(s)) }
      else if let k = step["key"] as? Int { events += [.keyboard(direction: .down, keyCode: UInt32(k)), .keyboard(direction: .up, keyCode: UInt32(k))] }
      else if let c = step["combo"] as? [String: Any], let k = c["key"] as? Int {
        let mods = ((c["mods"] as? [Int]) ?? []).map { UInt32($0) }
        events += mods.map { .keyboard(direction: .down, keyCode: $0) }
        events += [.keyboard(direction: .down, keyCode: UInt32(k)), .keyboard(direction: .up, keyCode: UInt32(k))]
        events += mods.reversed().map { .keyboard(direction: .up, keyCode: $0) }
      }
      else if let t = step["type"] as? String { events += try TextToHIDEvents.convertTextToHIDEvents(t) }
      else if let p = step["touch"] as? [Double], p.count == 2 {
        events += [.touch(direction: .down, x: p[0], y: p[1]), .delay(step["hold"] as? Double ?? 0.1), .touch(direction: .up, x: p[0], y: p[1])]
      }
      else { throw EngineError(message: "unknown step \(step)") }
    }
    return .composite(events)
  default:
    throw EngineError(message: "input: an op of tap, swipe, drag or steps")
  }
}
/**
 * The requests, one per line on stdin, read on a thread of their own. The main actor, where requests run one at a
 * time, only awaits the next line and never blocks in a read of stdin: FBSimulatorControl 2's actors, its HID
 * connection's readiness and the signal handlers below all need it free between requests. The stream ends with stdin.
 */
func requestLines() -> AsyncStream<String> {
  AsyncStream { continuation in
    let reader = Thread {
      while let line = readLine() { continuation.yield(line) }
      continuation.finish()
    }
    reader.name = "simulator-use-engine stdin"
    reader.start()
  }
}

/** Requests that send input to the phone: after one, the kept read (Settle.swift) is the past. */
let inputOps: Set<String> = ["tap", "swipe", "type", "steps", "drag", "lock", "home", "open_url", "tap_settle_describe", "tap_trace", "hinge"]

// MARK: Screens and input

/** The phone's screens (Screens.swift), from the start: one on a phone, two on a foldable. */
var screens: Screens!
/** A foldable's screen in use (nil on a one-screen phone): reads and input go to it by its display. */
@MainActor func foldSlot() -> ScreenSlot? { (screens?.foldable ?? false) ? screens.applied : nil }

/** The measured context a screen-targeted touch connection and a read by display take. */
func displayContext(_ g: ScreenGeometry, id: UInt32) throws -> FBSimulatorHIDDisplayContext {
  let rotation: FBSimulatorHIDDisplayRotation = g.rotation == 90 ? .rot90 : g.rotation == 180 ? .rot180 : g.rotation == 270 ? .rot270 : .rot0
  return try FBSimulatorHIDDisplayContext(hidTarget: UInt64(id), nativePixelSize: g.native, scale: Double(g.scale), rotation: rotation)
}

/** A one-screen phone's input (Input.swift): Indigo, and dtuhidd for keys while it runs. */
var phoneInput: PhoneInput!
/** A foldable: the screen an input request aims at, and the screens' generation when it started. */
var inputAim: (slot: ScreenSlot, generation: Int)?
/** Whether the request's input went out (a failure after it must not make the caller send it again). */
var inputSent = false

/** Every piece of an event in order, composites opened. */
func primitives(_ event: FBSimulatorHIDEvent) -> [FBSimulatorHIDEvent] {
  if case let .composite(events) = event { return events.flatMap(primitives) }
  return [event]
}

/**
 * A foldable's touch connection to one screen (AXe 2.0's DTUHID transport aimed at the screen: a tap in the
 * interface's points, turned to the panel's own as the guest draws it), made once per screen and geometry and kept.
 */
@MainActor
func touchConnection(_ slot: ScreenSlot) async throws -> FBSimulatorHID {
  if let made = slot.hid, made.geometry == slot.geometry { return made.connection }
  // One being made already (the warm-up at start or after a fold): that one.
  if let making = slot.making, making.geometry == slot.geometry { return try await making.task.value }
  slot.hid?.connection.disconnect()
  slot.hid = nil
  let geometry = slot.geometry
  let task = Task { @MainActor in try await openTouchConnection(slot, geometry) }
  slot.making = (geometry, task)
  defer { if slot.making?.geometry == geometry { slot.making = nil } }
  return try await task.value
}

/**
 * Makes a screen's touch connection. Nothing is sent on it here: the guest serves a new connection when its first
 * input arrives (measured by AXe 2.0 at under a second on a healthy phone), so the first input to each screen in an
 * engine's life takes that long, and a guest that does not answer within the transport's own limit fails that input,
 * said as such, its connection dropped for the next input to make a new one.
 */
@MainActor
func openTouchConnection(_ slot: ScreenSlot, _ geometry: ScreenGeometry) async throws -> FBSimulatorHID {
  let connection = try FBSimulatorHID(for: screens.simulator, displayContext: displayContext(geometry, id: slot.id))
  if slot.geometry == geometry { slot.hid = (geometry, connection) }
  return connection
}

/**
 * Sends an input. A one-screen phone: by PhoneInput (Input.swift). A foldable: each piece to the screen the request
 * aimed at, one at a time on that screen's kept dtuhidd connection (without AXe's drain after a gesture, as
 * PhoneInput sends), checked before each that the screen in use is still that one; when it changed, the rest is
 * refused (screen_changed) after a finger still down is lifted. Keys are paced as AXe paces them on this transport.
 */
@MainActor
func send(_ event: FBSimulatorHIDEvent) async throws {
  guard let aim = inputAim, screens.foldable else {
    try await phoneInput.send(event)
    inputSent = true
    return
  }
  let connection = try await touchConnection(aim.slot)
  // A connection that failed is closed for good (AXe's transport): the next input makes a new one.
  do { try await sendPieces(event, aim, connection) } catch { if !(error is ScreenError) { aim.slot.hid?.connection.disconnect(); aim.slot.hid = nil }; throw error }
}

@MainActor
func sendPieces(_ event: FBSimulatorHIDEvent, _ aim: (slot: ScreenSlot, generation: Int), _ connection: FBSimulatorHID) async throws {
  let size = aim.slot.geometry.points
  let clamp = { (x: Double, y: Double) in (min(max(x, 0), Double(size.width)), min(max(y, 0), Double(size.height))) }
  var down: (Double, Double)? = nil
  // Keys in a row (with the pauses between them) go as one input, paced as AXe paces keys on this transport
  // (PhoneInput.pacedForDtuhid); anything else goes one piece at a time, the screen in use checked before each.
  var runs: [(keys: Bool, pieces: [FBSimulatorHIDEvent])] = []
  for piece in primitives(event) {
    let isKey: Bool = { if case .keyboard = piece { return true }; if case .delay = piece { return runs.last?.keys == true }; return false }()
    if runs.last?.keys == isKey && isKey { runs[runs.count - 1].pieces.append(piece) } else { runs.append((isKey, [piece])) }
  }
  for run in runs {
    if case let .delay(seconds) = run.pieces[0], !run.keys {
      try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
      continue
    }
    if let refusal = screens.inputAllowed(aimedAt: aim.slot, generation: aim.generation), refusal.code == "screen_changed" {
      if let (x, y) = down { try? await FBSimulatorHIDEvent.touch(direction: .up, x: x, y: y).sendAsync(on: connection) }
      throw refusal
    }
    // Handed to the transport, input may reach the phone even when its reply then fails: from here it counts as
    // sent, so the caller never sends it again another way.
    inputSent = true
    if run.keys {
      try await PhoneInput.pacedForDtuhid(.composite(run.pieces)).sendAsync(on: connection)
      continue
    }
    switch run.pieces[0] {
    case let .touch(direction, x, y):
      let (cx, cy) = clamp(x, y)
      try await FBSimulatorHIDEvent.touch(direction: direction, x: cx, y: cy).sendAsync(on: connection)
      down = direction == .down ? (cx, cy) : nil
    case let .twoFingerTouch(direction, a, b):
      let (ax, ay) = clamp(Double(a.x), Double(a.y)), (bx, by) = clamp(Double(b.x), Double(b.y))
      try await FBSimulatorHIDEvent.twoFingerTouch(direction: direction, finger1: CGPoint(x: ax, y: ay), finger2: CGPoint(x: bx, y: by)).sendAsync(on: connection)
    default:
      try await run.pieces[0].sendAsync(on: connection)
    }
  }
}

/** Something that happens once, and the waits for it (a stream's end). */
@MainActor
final class Once {
  private var fired = false
  private var waiting: [CheckedContinuation<Void, Never>] = []
  nonisolated func fire() { Task { @MainActor in self.fireNow() } }
  private func fireNow() { guard !fired else { return }; fired = true; for w in waiting { w.resume() }; waiting = [] }
  func wait() async { if fired { return }; await withCheckedContinuation { waiting.append($0) } }
}

/**
 * The highest QoS the engine's own work runs at: what it was started at (hostd may start an engine for the live view's
 * stills at utility, which its main thread inherits), or --qos NAME (utility, background, ...), whichever is lower.
 * The main thread takes it at start, and every queue the engine makes is made at most at it.
 */
let qosCeiling: qos_class_t = {
  // Only a deliberately low start counts (utility or background); a process started the ordinary way runs at default.
  let inherited = qos_class_self()
  var ceiling = inherited.rawValue <= QOS_CLASS_UTILITY.rawValue && inherited != QOS_CLASS_UNSPECIFIED ? inherited : QOS_CLASS_USER_INTERACTIVE
  if let i = args.firstIndex(of: "--qos"), i + 1 < args.count, let raw = qosNamed(args[i + 1]), raw < ceiling.rawValue { ceiling = qos_class_t(rawValue: raw) }
  return ceiling
}()
/** A QoS for one of the engine's queues: the one wanted, or the ceiling when that is lower. */
func capped(_ wanted: DispatchQoS.QoSClass) -> DispatchQoS {
  let ceiling = DispatchQoS.QoSClass(rawValue: qosCeiling) ?? .utility
  return DispatchQoS(qosClass: wanted.rawValue.rawValue > qosCeiling.rawValue ? ceiling : wanted, relativePriority: 0)
}

/** Stills (the still op): the counter the live view's still mode holds. */
var stillTracker = StillTracker()

/**
 * {"op": "still", "since": N, "scale": 0..1, "quality": 0..1}: the screen in use as a JPEG, for a live view that
 * cannot play H.264. seed is the engine's still counter, which moves whenever the screen in use, its turn, its buffer
 * or anything written to the buffer changed; when it is since, the answer is {"unchanged": true, "seed"} and nothing is
 * captured. The JPEG is the screen as drawn at scale (default 0.5), within stillMaxBytes (the quality halved until it
 * fits).
 */
@MainActor
func still(_ req: [String: Any], _ answer: inout [String: Any]) throws {
  let slot = screens.applied
  guard let surface = slot.watcher.currentSurface() else { throw EngineError(message: "the \(slot.role) screen has no picture yet") }
  let seed = stillTracker.counter(for: StillKey(screen: slot.id, rotation: slot.geometry.rotation, surface: surfaceID(surface), seed: surfaceSeed(surface)))
  answer["seed"] = seed
  if let since = intValue(req["since"]), since == seed { answer["unchanged"] = true; return }
  let scale = stillScale(number(req["scale"])), drawn = slot.geometry.drawnPixels
  let size = CGSize(width: max(1, (drawn.width * scale).rounded()), height: max(1, (drawn.height * scale).rounded()))
  let picture = try drawnPicture(surface, slot.geometry, size: size)
  for quality in stillQualities(from: stillQuality(number(req["quality"]))) {
    let jpg = try encodeImage(picture, as: .jpeg, quality: quality)
    if jpg.count <= stillMaxBytes {
      answer["jpeg_base64"] = jpg.base64EncodedString(); answer["bytes"] = jpg.count; answer["quality"] = quality
      answer["width"] = picture.width; answer["height"] = picture.height
      return
    }
  }
  throw EngineError(message: "the still is larger than \(stillMaxBytes) bytes at the lowest quality: ask a smaller scale")
}

/**
 * AXe 2.0's live freshness provider for the screen in use, kept for its motion feed: the count of hinge samples it
 * received tells a stream the hinge moved. Made again for each screen in use (the provider is bound to one).
 */
final class MotionFollower: @unchecked Sendable {
  private let lock = NSLock()
  private var provider: FBSimulatorHIDNativeFreshnessProvider?
  private var base: UInt64 = 0
  /** Samples seen across every provider so far (a new provider counts from zero). */
  func count() -> UInt64? {
    lock.lock(); defer { lock.unlock() }
    guard let provider else { return nil }
    return base + provider.status().motionSampleCount
  }
  @MainActor
  func follow(_ simulator: FBSimulator, _ slot: ScreenSlot) async {
    guard let uuid = UUID(uuidString: slot.uniqueID) else { return }
    let made = try? await FBSimulatorHIDNativeFreshnessProvider.start(for: simulator, screenID: slot.id, screenUniqueID: uuid)
    replace(with: made)
    screens.noteResolve(made == nil ? "motion feed not started for screen \(slot.id)" : "motion feed for screen \(slot.id)")
  }
  private func replace(with made: FBSimulatorHIDNativeFreshnessProvider?) {
    lock.lock(); defer { lock.unlock() }
    if let old = provider { base += old.status().motionSampleCount + 1; old.close() }
    provider = made
  }
  func close() { replace(with: nil) }
}

/** Called before the engine exits on a signal (a recording's last frame and index). */
var exitFinishers: [() -> Void] = []

/**
 * Every descriptor past stderr closed in any process the engine starts (the session's daemons restarted, a framework's
 * helper): whatever the engine was handed or opened stays its own. Run at start and before each process it starts.
 */
func closeOnExecAll() {
  let limit = min(Int(getdtablesize()), 4096)
  for fd in 3..<Int32(limit) {
    let flags = fcntl(fd, F_GETFD)
    if flags >= 0 && flags & FD_CLOEXEC == 0 { _ = fcntl(fd, F_SETFD, flags | FD_CLOEXEC) }
  }
}
/** The screen event the ready line stood for: a stream tells a change from it. */
var readyEvent: String?

@MainActor
func main() async {
  do {
    try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
    try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
    if !args.contains("--bootstrap-every-call") { installPersistentBootstrap() }
    let control = try FBSimulatorControl.withConfiguration(FBSimulatorControlConfiguration(deviceSetPath: deviceSetPath, logger: logger, reporter: nil))
    guard let simulator = control.set.allSimulators.first(where: { $0.udid == udid }) else { throw EngineError(message: "no simulator \(udid)") }
    guard simulator.state == .booted else { throw EngineError(message: "simulator \(udid) is not booted") }
    // App accessibility on at once: the phone's apps then load it (10 to 12 s on a busy Mac) while the engine starts
    // and the first session is requested, as 0.17.0's reads had them do (switchAccessibilityOn). Not for an engine that
    // never reads (--no-bootstrap: the live view's).
    if !skipBootstrap { switchAccessibilityOn(device: simulator.device) }
    let loaded = ms(started)
    // A foldable (the device type declares two integrated touch screens and a hinge) is followed screen by screen;
    // any other phone exactly as before.
    let capability = try? FBSimulatorNativeContextReader.capability(for: simulator)
    let foldIDs = capability?.hinge == .supported ? (capability?.integratedDigitizerIDs ?? []) : []
    // The main thread at the QoS ceiling (--qos lower than what the engine was started at).
    if qosCeiling.rawValue < qos_class_self().rawValue { pthread_set_qos_class_self_np(qosCeiling, 0) }
    var ready: [String: Any] = ["ready": true, "load_ms": loaded, "name": simulator.name, "reads": readPathName, "input": ["points", "normalized"],
                                "stills": ["since"], "qos": qosCeiling == QOS_CLASS_USER_INTERACTIVE ? "unbounded" : String(format: "0x%x", qosCeiling.rawValue)]
    if foldIDs.count >= 2 {
      let screensStart = Date()
      screens = try await Screens.foldable(simulator, ids: foldIDs)
      ready["screens_ms"] = ms(screensStart); ready["hid"] = "dtuhid"; ready["foldable"] = true
      ready["surface"] = screens.applied.watcher.currentSurface() != nil
    } else {
      let hidStart = Date()
      // How input goes is chosen before each input, not once by AXe's connectToHID (Input.swift).
      phoneInput = PhoneInput(simulator, choice: PhoneInput.choiceFromArguments(), logger: logger)
      try await phoneInput.start()
      ready["hid_ms"] = ms(hidStart)
      for (key, value) in phoneInput.describe() { ready[key] = value }
      let watcher = DamageWatcher()
      let fbStart = Date()
      let framebuffer: FBFramebuffer? = try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<FBFramebuffer, Error>) in
        DispatchQueue.global().async { do { cont.resume(returning: try simulator.connectToFramebuffer().block()) } catch { cont.resume(throwing: error) } }
      }
      let surface = framebuffer?.attach(watcher, on: DispatchQueue(label: "damage", qos: capped(.default)))
      watcher.surface = surface
      ready["framebuffer_ms"] = ms(fbStart); ready["framebuffer"] = framebuffer != nil; ready["surface"] = surface != nil
      // The screen in pixels and its scale (points = pixels / scale), so a live view maps a click to a tap.
      var native = CGSize.zero, scale: CGFloat = 1
      if let surface {
        let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
        native = CGSize(width: IOSurfaceGetWidth(ref), height: IOSurfaceGetHeight(ref))
      }
      if let s = (simulator as AnyObject).value(forKeyPath: "device.deviceType.mainScreenScale") as? NSNumber, s.doubleValue > 0 { scale = CGFloat(s.doubleValue) }
      let slot = ScreenSlot(id: capability?.integratedDigitizerIDs.first ?? 1, uniqueID: "", role: "main", geometry: ScreenGeometry(native: native, scale: scale, rotation: 0), watcher: watcher)
      screens = Screens(simulator: simulator, single: slot)
      activate(slot)
    }
    // The seed clock: when the screen in use last changed, known at any moment (a seed read every 8 ms costs nothing).
    // Started once the screen's scale is known: it tells a caret's blink by its size in points.
    let seedClock = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "seed", qos: capped(.utility)))
    seedClock.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(2))
    seedClock.setEventHandler { if let slot = activeWatcherBox.slot { slot.watcher.pollSeed(); slot.clock.tick(slot.watcher.currentSurface()) } }
    seedClock.resume()
    seedClocks.append(seedClock)
    for (key, value) in screens.answerFields() { ready[key] = value }
    readyEvent = screens.applied.eventLine(posture: screens.posture)
    closeOnExecAll()
    emit(ready)

    // On a queue of their own: a signal must end the engine also while a read holds the main thread (a read of a
    // hung phone never returns, and on the main queue the signal then never ran: the engine stayed for ever with its
    // session open). The session is closed first either way, so the next engine keeps the gap.
    let signalQueue = DispatchQueue(label: "simulator-use-engine.signals")
    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
      source.setEventHandler { for finish in exitFinishers { finish() }; closeSession(); exit(0) }
      source.resume(); signalSources.append(source)
    }
    for await line in requestLines() {
      // Nobody reads the answers any more: as at the end of the requests, the session is closed below.
      if outputGone { break }
      let t0 = Date()
      guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let op = req["op"] as? String else { emit(["ok": false, "error": "bad request"]); continue }
      let id = req["id"] ?? NSNull()
      let clearsKept = inputOps.contains(op) || (op == "watch" && req["tap"] != nil)
      if clearsKept { keptRead = nil }
      // settle_read keeps the kept read for its baseline (Settle.swift) and lets it go itself.
      let sendsInput = clearsKept || (op == "settle_read" && req["input"] != nil)
      phoneInput?.beginRequest()
      // settle_read's input went out: a failure after it (the read) must not be answered by sending it again.
      inputSent = false
      inputAim = nil
      do {
        // A foldable: the screen in use as last read becomes the engine's; an input waits (up to 3 s) for a change
        // in progress to finish, and is aimed at the screen in use then.
        if screens.foldable {
          if sendsInput && op != "hinge" {
            await screens.waitUntilSteady()
            if screens.changing { throw ScreenError(code: "screen_changing", message: "The screens are still changing (a fold): nothing was sent. Read the screen again in a moment.") }
            if let refusal = screens.inputAllowed(aimedAt: screens.applied, generation: screens.generation) { throw refusal }
            inputAim = (screens.applied, screens.generation)
          } else {
            screens.apply()
          }
        }
        var answer: [String: Any] = ["id": id, "ok": true]
        switch op {
        case "methods":
          // A look at a private class's methods (exploration): {"op":"methods","class":"XCUIDeviceRemoteAutomationSession"}.
          guard let name = req["class"] as? String, let cls: AnyClass = NSClassFromString(name) else { throw EngineError(message: "no such class") }
          func list(_ c: AnyClass) -> [String] {
            var count: UInt32 = 0
            guard let methods = class_copyMethodList(c, &count) else { return [] }
            defer { free(methods) }
            return (0..<Int(count)).map { NSStringFromSelector(method_getName(methods[$0])) }.sorted()
          }
          answer["instance"] = list(cls)
          if let meta = object_getClass(cls) { answer["class_methods"] = list(meta) }
          answer["superclass"] = class_getSuperclass(cls).map { NSStringFromClass($0) } ?? ""
        case "screen":
          // The screen in use (every answer carries it; this one does nothing else).
          break
        case "still":
          try still(req, &answer)
        case "screens":
          // Every screen, the one in use as last read from the phone, and what the callbacks said (diagnostics).
          if screens.foldable { await screens.refreshNow(hinge: true); screens.apply() }
          answer["screens"] = screens.slots.map { slot -> [String: Any] in
            var s = slot.json
            s["native"] = [Int(slot.geometry.native.width), Int(slot.geometry.native.height)]; s["rotation"] = slot.geometry.rotation
            if let surface = slot.watcher.currentSurface() {
              let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
              s["surface"] = [IOSurfaceGetWidth(ref), IOSurfaceGetHeight(ref), Int(IOSurfaceGetPixelFormat(ref)), Int(IOSurfaceGetSeed(ref))]
            }
            return s
          }
          answer["foldable"] = screens.foldable; answer["generation"] = screens.generation; answer["changing"] = screens.changing
          // The host's own view of each screen (CoreSimulator's properties), beside the guest's report above.
          if let host = try? await FBSimulatorDisplayDiscovery.displays(for: simulator) {
            answer["host"] = host.map { ["id": Int($0.screenID), "power": Int($0.rawPowerState), "backlight": $0.rawBacklightState.map { Int($0) } ?? -1, "brightness": $0.backlightBrightnessFactor ?? -1, "orientation": Int($0.rawUIOrientation)] as [String: Any] }
          }
          answer["resolved"] = screens.lastResolve; answer["callbacks"] = screens.callbackCounts; answer["log"] = screens.callbackLog
          answer["touch_connections"] = screens.slots.filter { $0.hid != nil }.map { Int($0.id) }
        case "hinge":
          try await fold(simulator, req, &answer)
        case "describe":
          var keys = outputKeys
          if let names = req["keys"] as? [String] {
            // An unknown name would silently drop that attribute from every element (AXLabel for label read as no text).
            let unknown = names.filter { keyNamed($0) == nil }
            if !unknown.isEmpty { throw EngineError(message: "unknown keys \(unknown.joined(separator: ", ")); the names are label, frame, value, uniqueID, type, title, frameDict, help, enabled, customActions, role, roleDescription, subrole, contentRequired, pid, traits, expanded, placeholder, hidden, focused, isRemote") }
            keys = Set(names.compactMap(keyNamed))
          } else if (req["lean"] as? Bool) == true {
            keys = leanKeys
          }
          readRemote = remoteOptions(req["remote"]); readProfile = (req["profile"] as? Bool) ?? false; lastReadReport = [:]
          webScanOn = (req["web"] as? Bool) ?? true; webBudget = (req["web_budget_ms"] as? Double).map { $0 / 1000 } ?? 2.5
          defer { readRemote = nil; readProfile = false; webScanOn = true; webBudget = 2.5 }
          let nested = (req["nested"] as? Bool) ?? true
          lastSerializeMs = []
          // reuse: the last read again while the screen's pixels are as they were then (Settle.swift), within max_age_ms.
          var again: (tree: Any?, why: String) = (nil, "")
          if (req["reuse"] as? Bool) == true { again = await reusableRead(simulator, keys: keys, nested: nested, maxAge: (req["max_age_ms"] as? Double ?? 30_000) / 1000) }
          if let tree = again.tree {
            answer["tree"] = tree; answer["reused"] = again.why
          } else {
            if !again.why.isEmpty { answer["not_reused"] = again.why }
            let still = writeClock?.sinceSignificantWrite() ?? 0
            let read = try await trackedRead(simulator, keys: keys, nested: nested, stillBefore: still >= 0.1)
            answer["tree"] = read.tree; answer["kept"] = read.kept; answer["still_ms"] = Int(still * 1000)
          }
          answer["cpu_ms"] = cpuMs(); answer["serialize_ms"] = lastSerializeMs
          if sessionTurnMs > 0 { answer["session_wait_ms"] = sessionTurnMs; sessionTurnMs = 0 }
          if sessionRecoveries > 0 { answer["session_recoveries"] = sessionRecoveries }
          if sessionsReopened > 0 { answer["sessions_reopened"] = sessionsReopened }
          for (key, value) in lastReadReport { answer[key] = value }
        case "point":
          let x = coordinate(req, "x", "nx", along: display.width), y = coordinate(req, "y", "ny", along: display.height)
          for attempt in 0..<2 {
            do {
              let element = try await pointElement(simulator, CGPoint(x: x, y: y), reload: attempt > 0)
              defer { element.close() }
              // nested: the element with everything under it (a hit on a web page's background is the page).
              answer["element"] = onScreen(withDefaults(try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: (req["nested"] as? Bool) ?? false, keys: outputKeys)).elements), at: CGPoint(x: x, y: y))
              break
            } catch {
              if attempt == 0 && String(describing: error).contains("No translation object") { continue }
              throw error
            }
          }
        case "tap", "swipe":
          var input = req; input["op"] = op
          try await send(try inputEvent(input))
        case "type":
          let text = req["text"] as? String ?? ""
          try await send(.composite(try TextToHIDEvents.convertTextToHIDEvents(text)))
        case "steps", "drag":
          try await send(try inputEvent(req))
        case "lock":
          try await send(.shortButtonPress(.lock))
        case "open_url":
          // The link comes on the engine's input, never in an argument (simctl openurl's), which every user of a Mac can read.
          guard let text = req["url"] as? String, let url = URL(string: text), url.scheme != nil else { throw EngineError(message: "url: a link with a scheme") }
          let target = simulator
          try await blocking { _ = try target.open(url).block() }
        case "settle":
          let (waited, updates, settled) = await settle(screenWatcher!, quietMs: req["quiet_ms"] as? Double ?? 150, timeoutMs: req["timeout_ms"] as? Double ?? 4000, firstChangeMs: req["first_change_ms"] as? Double ?? 0)
          answer["waited_ms"] = waited; answer["updates"] = updates; answer["settled"] = settled
        case "settle_read":
          // An input (optional), the wait until the screen holds still, and the read: one request (Settle.swift).
          let event = try (req["input"] as? [String: Any]).map(inputEvent)
          lastReadReport = [:]
          lastSerializeMs = []
          readPhases = []
          // web false: no point scan of a web page (simulator-use has the page's own word for it, src/web).
          webScanOn = (req["web"] as? Bool) ?? true
          defer { webScanOn = true }
          let result = try await settleRead(simulator, input: event.map { e in { try await send(e) } },
            firstChangeMs: req["first_change_ms"] as? Double ?? 800, quietMs: req["quiet_ms"] as? Double ?? 150, startMs: req["start_ms"] as? Double ?? 50,
            guardMs: req["guard_ms"] as? Double ?? 35, timeoutMs: req["timeout_ms"] as? Double ?? 4000, keys: (req["lean"] as? Bool) == true ? leanKeys : outputKeys,
            fromKept: (req["baseline"] as? String) == "kept", traced: (req["trace"] as? Bool) == true, wholeStill: (req["whole_still"] as? Bool) == true)
          for (key, value) in result { answer[key] = value }
          if (req["trace"] as? Bool) == true { answer["read_phases"] = readPhases }
          if let scan = lastReadReport["web_scan"] { answer["web_scan"] = scan }
        case "tap_settle_describe":
          // One call for an act: the tap, the wait until the screen stops changing, then the new tree.
          let x = coordinate(req, "x", "nx", along: display.width), y = coordinate(req, "y", "ny", along: display.height)
          lastReadReport = [:]
          try await send(.tapAt(x: x, y: y))
          let (waited, updates, settled) = await settle(screenWatcher!, quietMs: req["quiet_ms"] as? Double ?? 150, timeoutMs: req["timeout_ms"] as? Double ?? 4000, firstChangeMs: req["first_change_ms"] as? Double ?? 800)
          let readStart = Date()
          // An app still launching reads as an application with nothing in it: wait for content, up to 3 s.
          var tree: Any = []; var reads = 0
          let before = lastTreeSignature
          while true {
            tree = try await readFrontmost(simulator, keys: outputKeys); reads += 1
            // The screen moved but reads as before: the change (an app opening) is not in the tree yet.
            let unchanged = updates > 0 && signature(tree) == before
            if (!isEmptyApp(tree) && !unchanged) || Date().timeIntervalSince(readStart) > 2.5 { break }
            _ = await settle(screenWatcher!, quietMs: 150, timeoutMs: 1000, firstChangeMs: 0)
          }
          answer["tree"] = tree; answer["settle_ms"] = waited; answer["updates"] = updates; answer["settled"] = settled; answer["read_ms"] = ms(readStart); answer["reads"] = reads
          if let scan = lastReadReport["web_scan"] { answer["web_scan"] = scan }
        case "watch":
          // Where the screen changes over window_ms, each change as [ms, x, y, width, height] in points (the box
          // around what changed since the frame before; [ms] alone: the seed moved but no pixel did). An optional
          // tap [x, y] first.
          let windowMs = req["window_ms"] as? Double ?? 2000
          guard let watcher = screenWatcher, let surface = watcher.currentSurface() else { throw EngineError(message: "no screen buffer") }
          let reference = PixelReference()
          guard reference.capture(surface) else { throw EngineError(message: "the screen buffer can't be read") }
          var lastSeed = reference.seed
          if let p = req["tap"] as? [Double], p.count == 2 { try await send(.tapAt(x: p[0], y: p[1])) }
          let start = Date(); var changes: [[Double]] = []; var diffMs = 0.0, diffs = 0
          while Date().timeIntervalSince(start) * 1000 < windowMs {
            try? await Task.sleep(nanoseconds: 4_000_000)
            guard let seed = watcher.currentSeed(), seed != lastSeed else { continue }
            lastSeed = seed
            let at = Double(ms(start)), d0 = Date()
            let (readable, box) = reference.diff(surface, update: true)
            diffMs += Date().timeIntervalSince(d0) * 1000; diffs += 1
            if !readable { changes.append([at, -1]); _ = reference.capture(surface); continue }
            if let box { changes.append([at] + rectArray(pointsBox(box))) }
            else { changes.append([at]) }
          }
          answer["changes"] = changes; answer["diff_ms_avg"] = diffs > 0 ? diffMs / Double(diffs) : 0
        case "tap_trace":
          // When the screen changes after a tap: one timestamp (ms after the tap) per surface change.
          let x = coordinate(req, "x", "nx", along: display.width), y = coordinate(req, "y", "ny", along: display.height), windowMs = req["window_ms"] as? Double ?? 3000
          guard let watcher = screenWatcher else { throw EngineError(message: "no screen buffer") }
          let sendStart = Date()
          try await send(.tapAt(x: x, y: y))
          answer["send_ms"] = Date().timeIntervalSince(sendStart) * 1000
          let start = Date(); var changes: [Int] = []; var last = watcher.snapshot().1
          while Date().timeIntervalSince(start) * 1000 < windowMs {
            try? await Task.sleep(nanoseconds: 5_000_000); watcher.pollSeed()
            let now = watcher.snapshot().1; if now != last { changes.append(ms(start)); last = now }
          }
          answer["changes"] = changes
        case "home":
          // A press, held briefly; if the screen did not change, once more (a press during an app's launch is dropped).
          // With "wait": false only the press (the caller waits for the screen itself).
          let press = FBSimulatorHIDEvent.composite([.button(direction: .down, button: .homeButton), .delay(0.06), .button(direction: .up, button: .homeButton)])
          for attempt in 0..<((req["wait"] as? Bool) == false ? 1 : 2) {
            if (req["wait"] as? Bool) == false {
              try await send(press)
              break
            }
            try await send(press)
            let (_, updates, _) = await settle(screenWatcher!, quietMs: 150, timeoutMs: 3000, firstChangeMs: 600)
            answer["attempts"] = attempt + 1; answer["updates"] = updates
            if updates > 0 { break }
          }
        case "screenshot":
          try await screenshot(simulator, req, t0, &answer)
        case "stream":
          if screens.foldable { try await streamScreens(req, t0, &answer) } else { try await streamMain(simulator, req, t0, &answer) }
        default:
          throw EngineError(message: "unknown op \(op)")
        }
        for (key, value) in phoneInput?.report() ?? [:] { answer[key] = value }
        answer["ms"] = ms(t0); answer["bootstraps"] = bootstrapCount; answer["sessions"] = sessionsOpened
        for (key, value) in screens.answerFields() where answer[key] == nil { answer[key] = value }
        if let failure = lastBootstrapError { answer["bootstrap_error"] = failure; lastBootstrapError = nil }
        emit(answer)
      } catch {
        // input_sent: any of the request's input may have reached the phone; it must not be sent again another way.
        var failed: [String: Any] = ["id": id, "ok": false, "ms": ms(t0), "error": (error as? EngineError)?.message ?? (error as? ScreenError)?.message ?? String(describing: error), "input_sent": inputSent || (phoneInput?.sent ?? false)]
        if let typed = error as? ScreenError { failed["code"] = typed.code }
        for (key, value) in screens?.answerFields() ?? [:] { failed[key] = value }
        for (key, value) in phoneInput?.report() ?? [:] { failed[key] = value }
        emit(failed)
      }
    }
    for finish in exitFinishers { finish() }
    closeSession()
    exit(0)
  } catch {
    emit(["ready": false, "error": (error as? EngineError)?.message ?? String(describing: error)])
    exit(1)
  }
}

// MARK: Screenshots

/** The screen in use: a PNG at its full size to png_path, and or a JPEG sized to points (width, height) inline or to path. */
@MainActor
func screenshot(_ simulator: FBSimulator, _ req: [String: Any], _ t0: Date, _ answer: inout [String: Any]) async throws {
  var size: (Double, Double)? = nil
  if let w = req["width"] as? Double, let h = req["height"] as? Double { size = (w, h) }
  if let slot = foldSlot() {
    // A foldable: the screen in use's own buffer, turned as drawn; no other process.
    guard let surface = slot.watcher.currentSurface() else { throw EngineError(message: "the \(slot.role) screen has no picture yet") }
    let full = try drawnPicture(surface, slot.geometry)
    answer["capture_ms"] = ms(t0)
    if let file = req["png_path"] as? String {
      let png = try encodeImage(full, as: .png)
      try png.write(to: URL(fileURLWithPath: file))
      answer["png_bytes"] = png.count
    }
    if (req["format"] as? String) == "png" { answer["bytes"] = try encodeImage(full, as: .png).count }
    else if req["png_path"] == nil || req["path"] != nil || req["inline"] as? Bool == true {
      let picture = size.map { s in (try? drawnPicture(surface, slot.geometry, size: CGSize(width: s.0, height: s.1))) ?? full } ?? full
      let jpg = try encodeImage(picture, as: .jpeg, quality: req["quality"] as? Double ?? 0.7)
      answer["bytes"] = jpg.count
      if let path = req["path"] as? String { try jpg.write(to: URL(fileURLWithPath: path)) }
      if req["inline"] as? Bool == true { answer["jpeg_base64"] = jpg.base64EncodedString() }
    }
    answer["width"] = full.width; answer["height"] = full.height
    return
  }
  let png = try await simulator.takeScreenshot(format: .png)
  let shotMs = ms(t0)
  // The screen at full size to a file (png_path), alone or beside the JPEG.
  if let file = req["png_path"] as? String {
    let opaque = try opaquePNG(png)
    try opaque.write(to: URL(fileURLWithPath: file))
    answer["png_bytes"] = opaque.count
  }
  if (req["format"] as? String) == "png" { answer["bytes"] = png.count }
  else if req["png_path"] == nil || req["path"] != nil || req["inline"] as? Bool == true {
    let jpg = try jpeg(fromPNG: png, maxPoints: size, quality: req["quality"] as? Double ?? 0.7)
    answer["bytes"] = jpg.count
    if req["path"] as? String != nil { try jpg.write(to: URL(fileURLWithPath: req["path"] as! String)) }
    if req["inline"] as? Bool == true { answer["jpeg_base64"] = jpg.base64EncodedString() }
  }
  answer["capture_ms"] = shotMs
}

// MARK: Streams

/** Where a stream goes: a descriptor the parent holds (fd; the live view's pipe), or a file (path). */
func streamOutput(_ req: [String: Any]) throws -> FileHandle {
  if let fd = req["fd"] as? Int {
    guard fd >= 1, fcntl(Int32(fd), F_GETFD) != -1 else { throw EngineError(message: "fd \(fd) is not open") }
    return FileHandle(fileDescriptor: Int32(fd), closeOnDealloc: false)
  }
  let path = req["path"] as? String ?? "/tmp/sue-stream.bin"
  FileManager.default.createFile(atPath: path, contents: nil)
  guard let file = FileHandle(forWritingAtPath: path) else { throw EngineError(message: "cannot write \(path)") }
  _ = fcntl(file.fileDescriptor, F_SETFD, FD_CLOEXEC)
  return file
}

/**
 * Hardware-encoded video of the screen for N seconds into a file, or into a descriptor the parent holds (fd; the live
 * view's pipe, the engine's stdout once it said ready). seconds 0: until the reader goes or the engine is ended (a
 * write to a closed pipe ends it). A one-screen phone: FBSimulatorControl's stream of its screen, as always.
 */
@MainActor
func streamMain(_ simulator: FBSimulator, _ req: [String: Any], _ t0: Date, _ answer: inout [String: Any]) async throws {
  let seconds = req["seconds"] as? Double ?? 10, fps = req["fps"] as? Double ?? 30
  let codec: FBVideoStreamCodec = (req["codec"] as? String) == "hevc" ? .hevc : .h264
  let transportName = req["transport"] as? String ?? "annexb"
  let transport: FBVideoStreamTransport = transportName == "fmp4" ? .fmp4 : (transportName == "mpegts" ? .mpegts : .annexB)
  let config = FBVideoStreamConfiguration(format: .compressedVideo(withCodec: codec, transport: transport), framesPerSecond: NSNumber(value: fps),
    rateControl: .bitrate(NSNumber(value: req["bitrate"] as? Double ?? 2_000_000)), scaleFactor: NSNumber(value: req["scale"] as? Double ?? 0.5), keyFrameRate: NSNumber(value: req["keyframe_s"] as? Double ?? 2))
  let stream = try await simulator.createStream(configuration: config)
  let fh = try streamOutput(req)
  let counter = StreamCounter(start: t0)
  let consumer = FBBlockDataConsumer.synchronousDataConsumer { data in fh.write(data); counter.add(data.count) }
  _ = cpuMs()
  try await blocking { try stream.startStreaming(consumer).block() }
  if seconds <= 0 { while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) } }
  try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  try await blocking { try stream.stopStreaming().block() }
  fh.closeFile()
  answer["bytes"] = counter.bytes; answer["chunks"] = counter.chunks; answer["first_chunk_ms"] = counter.first
  answer["kbit_s"] = Int(Double(counter.bytes) * 8 / 1000 / seconds); answer["engine_cpu_pct"] = Int(Double(cpuMs()) / (seconds * 10))
}

/**
 * A foldable's stream (Video.swift): H.264 of the screen in use, Annex B or fragmented MP4. Annex B (the live view)
 * follows the screen in use, its encoder restarted at each change, and tells each screen on fd 3 when that is open;
 * fragmented MP4 (a recording) is drawn on a canvas that holds every screen (canvas: true or false overrides).
 */
@MainActor
func streamScreens(_ req: [String: Any], _ t0: Date, _ answer: inout [String: Any]) async throws {
  let seconds = req["seconds"] as? Double ?? 10, fps = req["fps"] as? Double ?? 30
  guard (req["codec"] as? String ?? "h264") == "h264" else { throw EngineError(message: "a foldable's stream is H.264 only") }
  let transport = req["transport"] as? String ?? "annexb"
  guard transport == "annexb" || transport == "fmp4" else { throw EngineError(message: "a foldable's stream is Annex B or fragmented MP4") }
  let scale = CGFloat(req["scale"] as? Double ?? 0.5)
  let canvasMode = (req["canvas"] as? Bool) ?? (transport == "fmp4")
  let fh = try streamOutput(req)
  let counter = StreamCounter(start: t0)
  let mp4 = transport == "fmp4" ? FragmentedMP4(file: fh) : nil
  let canvas = canvasMode ? recordingCanvas(screens.slots.map(\.geometry), scale: scale, turns: true) : nil
  let stream = ScreenStream(qos: capped(.userInteractive), fps: fps, bitrate: req["bitrate"] as? Double ?? 2_000_000, keyframeSeconds: req["keyframe_s"] as? Double ?? 2, scale: scale, canvas: canvas,
    sink: { sample in
      if let mp4 { mp4.add(sample); counter.add(mp4.bytes - counter.bytes) }
      else if let data = annexB(sample) { fh.write(data); counter.add(data.count) }
    },
    announce: { line in writeEvent(line) })
  // A line only when the screen in use or the posture changes from what the ready line said.
  stream.told = readyEvent
  stream.target.set(screens.applied, line: screens.applied.eventLine(posture: screens.posture))
  screens.onChange.append { [weak stream] slot in stream?.target.set(slot, line: slot.eventLine(posture: screens.posture)) }
  screens.onPosture.append { [weak stream] in stream?.target.set(screens.applied, line: screens.applied.eventLine(posture: screens.posture)) }
  // The stream follows the screen in use: each change the screens' callbacks set off becomes the engine's at once.
  screens.follows = true
  screens.apply()
  // The posture between open and book changes no screen and calls back for none (measured): a live view's stream
  // follows the hinge itself through AXe 2.0's motion feed (its live freshness provider, a subscription to the hinge's
  // samples), read on each tick, the hinge read again when it moved.
  let motion = MotionFollower()
  if screens.foldable && !canvasMode {
    stream.motionCount = { motion.count() }
    stream.onMotion = { Task { @MainActor in screens.noteChange(hinge: true) } }
    await motion.follow(screens.simulator, screens.applied)
    screens.onChange.append { slot in Task { @MainActor in await motion.follow(screens.simulator, slot) } }
  }
  exitFinishers.append { motion.close() }
  _ = cpuMs()
  let ended = Once()
  stream.onFailure = { ended.fire() }
  stream.start()
  let finish = { stream.stop(); mp4?.finish(lastDuration: 1 / fps) }
  exitFinishers.append(finish)
  // Until seconds pass (0: until the reader goes or the engine is ended), or the encoder fails.
  if seconds > 0 { Task { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); ended.fire() } }
  await ended.wait()
  finish()
  motion.close()
  exitFinishers.removeAll()
  screens.follows = false
  if let failure = stream.failure { throw EngineError(message: failure) }
  if transport == "fmp4" || req["path"] != nil { fh.closeFile() }
  answer["bytes"] = counter.bytes; answer["chunks"] = counter.chunks; answer["first_chunk_ms"] = counter.first
  answer["kbit_s"] = Int(Double(counter.bytes) * 8 / 1000 / max(seconds, 0.001)); answer["engine_cpu_pct"] = Int(Double(cpuMs()) / (max(seconds, 0.001) * 10))
  answer["restarts"] = stream.restarts; answer["frames"] = stream.framesIn
  if let canvas { answer["canvas"] = [Int(canvas.width), Int(canvas.height)] }
}

// MARK: The fold

/**
 * Folds the phone: {"op": "hinge", "posture": "closed" | "book" | "open"}. The hinge is moved host side (AXe 2.0's
 * FBSimulatorHingeNative, for the boot the screens were read in, its receipt the angle reached: closed 0, book 90,
 * open 180 degrees). The answer then waits for the screen that goes with the posture (closed: the outer, book and open:
 * the inner) to be in use, as the guest's display report says it (Apple's 27.2 Duo moves its interface about 15 to 17 s
 * after a close or an open; see Screens.followSwitch), for the next read of the report to say the same, and for the
 * screen's picture to settle. Input in this engine waits meanwhile (its requests run one at a time); other engines
 * refuse it while the screens change. Typed errors: unsupported, busy, boot_changed, timeout, unavailable.
 */
@MainActor
func fold(_ simulator: FBSimulator, _ req: [String: Any], _ answer: inout [String: Any]) async throws {
  guard screens.foldable else { throw ScreenError(code: "unsupported", message: "This phone has one screen: it does not fold.") }
  guard let posture = req["posture"] as? String, postureDegrees[posture] != nil else { throw EngineError(message: "posture: closed, book or open") }
  let timeout = (req["timeout_ms"] as? Double ?? 40_000) / 1000
  let started = Date()
  await screens.refreshNow(hinge: true); screens.apply()
  // Half open straight from closed, Apple's 27.2 Duo shows the inner screen but CoreDevice's display report keeps
  // flagging the outer one for a minute or more (measured 3 of 3, AXe's own CLI as well; AXe 2.0's display policy
  // describes such stale reports), so no screen in use can be known and no input sent. By way of open it settles
  // every time (3 of 3): closed to book goes to open first, and the answer says so.
  if posture == "book" && screens.posture == "closed" {
    var first: [String: Any] = [:]
    try await foldStep(simulator, "open", deadline: Date().addingTimeInterval(timeout), &first)
    answer["via"] = "open"; answer["via_ms"] = ms(started)
  }
  try await foldStep(simulator, posture, deadline: Date().addingTimeInterval(timeout), &answer)
}

@MainActor
func foldStep(_ simulator: FBSimulator, _ posture: String, deadline: Date, _ answer: inout [String: Any]) async throws {
  let degrees = postureDegrees[posture]!
  let started = Date(), timeout = deadline.timeIntervalSince(started)
  await screens.refreshNow(hinge: true); screens.apply()
  guard let boot = screens.bootIdentity else { throw ScreenError(code: "unavailable", message: "The phone's boot could not be read.") }
  let want = posture == "closed" ? "outer" : "inner"
  guard let target = screens.slots.first(where: { $0.role == want }) else {
    throw ScreenError(code: "unavailable", message: "The phone's \(want) screen is not known.")
  }
  func typed(_ code: String?) -> String {
    switch code { case "busy", "closed": return "busy"; case "bootChanged": return "boot_changed"; case "unsupported": return "unsupported"; case "timeout", "deadline", "attemptLimit": return "timeout"; default: return "unavailable" }
  }
  let receipt: FBSimulatorHingeReceipt
  do {
    receipt = try await FBSimulatorHingeNative.operation(for: simulator).set(try FBSimulatorHingeRequest(degrees: degrees, expectedBootIdentity: boot, toleranceDegrees: 0.5, timeoutSeconds: 8))
  } catch let failure as FBSimulatorHingeFailure {
    if failure.delivery == .uncertain { inputSent = true }
    throw ScreenError(code: typed(failure.reason.rawValue), message: "The hinge did not reach \(posture): \(failure.detail)")
  }
  inputSent = !receipt.wasAlreadyWithinTolerance
  keptRead = nil
  let hingeMs = ms(started)
  // A first read of the guest after the move (the hinge settles a moment past the angle asked: 94.6 degrees for book,
  // during which the report reads as changing), then the screen that goes with the posture in use, woken by each read
  // the screens' callbacks, or a switch the posture calls for, set off.
  await screens.refreshNow(hinge: true)
  guard await screens.waitFor(deadline: deadline, until: { slot, _ in slot.id == target.id }) else {
    screens.apply()
    throw ScreenError(code: "timeout", message: "The hinge reached \(posture) but the \(want) screen did not come into use within \(Int(timeout)) s; the \(screens.applied.role) screen is in use.")
  }
  let switchMs = ms(started)
  // Held: the next read of the guest's report (its own steadiness by AXe's ActivePanelReader) says the same screen and
  // turn. AXe's hinge readiness observer was not used for this: its attempts are counted, not paced, and each compares
  // the hinge's samples before and after, which keep moving slightly half open, so at book it ran out of attempts while
  // the report itself held (measured).
  let held = (screens.resolvedSlot?.id, screens.resolvedTurn)
  await screens.refreshNow(hinge: true)
  guard !screens.unsteady, screens.resolvedSlot?.id == held.0, screens.resolvedTurn == held.1 else {
    screens.apply()
    throw ScreenError(code: "timeout", message: "The \(want) screen came into use but did not hold: the next read of the phone's display report \(screens.unsteady ? "could not be taken steadily" : "named the \(screens.resolvedSlot?.role ?? "other") screen").")
  }
  screens.apply()
  let settleStart = Date()
  let (_, _, settled) = await settle(screenWatcher!, quietMs: 300, timeoutMs: 5000, firstChangeMs: 0)
  answer["hinge_ms"] = hingeMs; answer["switch_ms"] = switchMs
  answer["settle_ms"] = ms(settleStart); answer["settled"] = settled; answer["already"] = receipt.wasAlreadyWithinTolerance
}
Task { await main() }
RunLoop.main.run()
