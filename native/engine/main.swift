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
func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0A]))
}
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
 * subsystem's lines): sessionWait's signal (LoadLog, SessionWait.swift). Started just before the request, which never
 * waits for it: a process spawned into a phone just booted takes 3 to 4 s to start on a busy Mac, and a request held
 * back that long until the stream listened made the first read 3 s slower (November 17, 2026: sessions in 12.2 to 15.0
 * s against 8.6 to 11.4 s). testmanagerd starts for the request seconds later, so its lines come once the stream
 * listens; a load that began before (a testmanagerd already there) and is not seen leaves its request to the first
 * timeout, as before there was a log. Never a read of the phone, which before its accessibility is loaded poisons its
 * CoreSimulatorBridge (SessionWait.swift). nil when the stream cannot start: no load is then seen.
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
 * throttled phones read). Not waited for. The process is kept until it ends, its outcome written to the session log.
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
  let started = Date()
  if let device, spawnInPhone(device, helper, done: { status in
    sessionLog("app accessibility switched on in the phone in \(ms(started)) ms (\(status.map { "exit \($0)" } ?? "spawn failed"))")
  }) { return }
  // No CoreSimulator spawn to call: simctl's.
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  process.arguments = ["simctl"] + (deviceSetPath.map { ["--set", $0] } ?? []) + ["spawn", udid, helper]
  process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
  process.terminationHandler = { p in sessionLog("app accessibility switched on in the phone in \(ms(started)) ms (simctl, exit \(p.terminationStatus))") }
  do { try process.run(); accessibilitySwitch = process } catch { sessionLog("app accessibility not switched on: \(error.localizedDescription)") }
}
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
  let load = startLoadLog()
  defer { load?.process.terminate() }
  // testmanagerd switches app accessibility off as it stops (its log: AXDisableAccessibilityOnTermination): on again.
  if restartingDaemons { switchAccessibilityOn(device: device) }
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
    let now = DispatchTime.now().uptimeNanoseconds, loadedAt = load?.log.loadedAt, loading = load?.log.loading ?? false
    clock.tick(at: now, clamped: phoneProcesses.clamped())
    // Which testmanagerd runs matters only once the first timeout has passed with accessibility not loaded; before,
    // the request is waited for whatever runs.
    if loadedAt == nil && now >= requested.uptimeNanoseconds + timeoutNanos {
      daemon = phoneProcesses.pid(named: "testmanagerd")
      daemonState = daemon <= 0 ? .none : (daemonStart(daemon, requested: requested.uptimeNanoseconds, requestedWall: requestedWall)
        ?? load?.log.launchedAt).map { Daemon.started(at: $0) } ?? .running
    } else { daemon = 0; daemonState = .running }
    state = sessionWait(now: now, requestedAt: requested.uptimeNanoseconds, loadedAt: loadedAt, loading: loading, daemon: daemonState,
                        timeout: timeoutNanos, deadline: deadline.uptimeNanoseconds, loadUntil: loadUntil, ran: clock.ran(since:))
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
func lastSessionClose() -> Double {
  guard let text = try? String(contentsOfFile: sessionLockPath(), encoding: .utf8) else { return 0 }
  return Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
}
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
  if sessionLockFD < 0 { sessionLockFD = open(sessionLockPath(), O_CREAT | O_RDWR, 0o600) }
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
  // The invalidation is a message to the phone's testmanagerd: give it time to arrive before the process ends.
  RunLoop.current.run(until: Date().addingTimeInterval(0.8))
  try? String(Date().timeIntervalSince1970).write(toFile: sessionLockPath(), atomically: false, encoding: .utf8)
  unlockSessionTurn()
}
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
      if let failure = loadAccessibility(session, timeout: 10) { lastBootstrapError = failure; return true }
      return true
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
/** The screen in points (the screen buffer's pixels over its scale), set at start. */
var display = CGSize.zero
/** Pixels per point of the screen buffer. */
var pixelScale: CGFloat = 1
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
/** The tree in screen points (see Placement). An app that fills the screen, as every app on an iPhone does, is as read. */
@MainActor
func onScreen(_ simulator: FBSimulator, _ tree: Any) async -> Any {
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
  var reloaded = false, reloadedAfterError = false
  lastSerializeMs = []
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
          try? await Task.sleep(nanoseconds: 250_000_000)
          let next = try await serializeFrontmost(simulator, keys: keys, nested: nested)
          let same = signature(next) == signature(tree)
          tree = next
          // Two equal reads of a nearly empty app are its shell before the content: not settled yet.
          if same && !isEmptyApp(tree) && nodeCount(tree) >= 12 { lastReadStable = true; break }
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
 * An input as one HID event: {"op": "tap", x, y}, {"op": "swipe", x1, y1, x2, y2, delta, duration}, {"op": "drag",
 * x1, y1, x2, y2, duration, steps, hold}, or {"op": "steps", steps: [...]}, simulator-use's input batch as one
 * composite: [{"tap":[x,y]}, {"sleep":s}, {"key":code}, {"combo":{"mods":[codes],"key":code}}, {"type":"text"},
 * {"touch":[x,y],"hold":s}].
 */
func inputEvent(_ req: [String: Any]) throws -> FBSimulatorHIDEvent {
  switch req["op"] as? String ?? "" {
  case "tap":
    return .tapAt(x: req["x"] as? Double ?? 0, y: req["y"] as? Double ?? 0)
  case "swipe":
    let x1 = req["x1"] as? Double ?? 0, y1 = req["y1"] as? Double ?? 0, x2 = req["x2"] as? Double ?? 0, y2 = req["y2"] as? Double ?? 0
    return .swipe(x1, yStart: y1, xEnd: x2, yEnd: y2, delta: req["delta"] as? Double ?? 10, duration: req["duration"] as? Double ?? 0.3)
  case "drag":
    // A finger put down, moved in steps and lifted (sliders, reordering); a swipe is a quick drag. up: false leaves the
    // finger down at the end, and down: false moves a finger left down so from where it is (x1, y1): a slider is set
    // by a finger held on it, moved while the slider is read (ui-act.ts). steps: 0 with down: false is the lift alone, an
    // up with no move before it: where no finger is down (a first move that never went out) it touches nothing, where a
    // move and an up would tap.
    let x1 = req["x1"] as? Double ?? 0, y1 = req["y1"] as? Double ?? 0, x2 = req["x2"] as? Double ?? 0, y2 = req["y2"] as? Double ?? 0
    let down = req["down"] as? Bool ?? true
    let duration = req["duration"] as? Double ?? 0.6, n = max(down ? 1 : 0, Int(req["steps"] as? Double ?? 20))
    var events: [FBSimulatorHIDEvent] = down ? [.touch(direction: .down, x: x1, y: y1), .delay(req["hold"] as? Double ?? 0.05)] : []
    for i in stride(from: 1, through: n, by: 1) { let f = Double(i) / Double(n); events += [.delay(duration / Double(n)), .touch(direction: .down, x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f)] }
    if req["up"] as? Bool ?? true { events.append(.touch(direction: .up, x: x2, y: y2)) }
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
let inputOps: Set<String> = ["tap", "swipe", "type", "steps", "drag", "lock", "home", "open_url", "tap_settle_describe", "tap_trace"]

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
    let hidStart = Date()
    // How input goes is chosen before each input, not once by AXe's connectToHID (Input.swift).
    let input = PhoneInput(simulator, choice: PhoneInput.choiceFromArguments(), logger: logger)
    try await input.start()
    let hidMs = ms(hidStart)
    let watcher = DamageWatcher()
    screenWatcher = watcher
    let fbStart = Date()
    let framebuffer: FBFramebuffer? = try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<FBFramebuffer, Error>) in
      DispatchQueue.global().async { do { cont.resume(returning: try simulator.connectToFramebuffer().block()) } catch { cont.resume(throwing: error) } }
    }
    let surface = framebuffer?.attach(watcher, on: DispatchQueue(label: "damage"))
    watcher.surface = surface

    // The screen in pixels and its scale (points = pixels / scale), so a live view maps a click to a tap.
    var screen: [String: Any] = [:]
    if let surface {
      let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
      screen["width"] = IOSurfaceGetWidth(ref); screen["height"] = IOSurfaceGetHeight(ref)
    }
    if let scale = (simulator as AnyObject).value(forKeyPath: "device.deviceType.mainScreenScale") as? NSNumber { screen["scale"] = scale.doubleValue }
    if let w = screen["width"] as? Int, let h = screen["height"] as? Int, let scale = screen["scale"] as? Double, scale > 0 { display = CGSize(width: Double(w) / scale, height: Double(h) / scale); pixelScale = scale }
    // The seed clock: when the screen last changed, known at any moment (a seed read every 8 ms costs nothing). Started
    // once the screen's scale is known: it tells a caret's blink by its size in points.
    let seedClock = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "seed", qos: .utility))
    seedClock.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(2))
    let clock = WriteClock()
    writeClock = clock
    seedClock.setEventHandler { watcher.pollSeed(); clock.tick(watcher.currentSurface()) }
    seedClock.resume()
    seedClocks.append(seedClock)
    var ready: [String: Any] = ["ready": true, "load_ms": loaded, "hid_ms": hidMs, "framebuffer_ms": ms(fbStart), "framebuffer": framebuffer != nil, "surface": surface != nil,
                                "name": simulator.name, "screen": screen, "reads": readPathName]
    for (key, value) in input.describe() { ready[key] = value }
    emit(ready)

    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { closeSession(); exit(0) }
      source.resume(); signalSources.append(source)
    }
    for await line in requestLines() {
      let t0 = Date()
      guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let op = req["op"] as? String else { emit(["ok": false, "error": "bad request"]); continue }
      let id = req["id"] ?? NSNull()
      if inputOps.contains(op) || (op == "watch" && req["tap"] != nil) { keptRead = nil }
      input.beginRequest()
      // settle_read's input went out: a failure after it (the read) must not be answered by sending it again.
      var inputSent = false
      do {
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
          for (key, value) in lastReadReport { answer[key] = value }
        case "point":
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
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
          var request = req; request["op"] = op
          try await input.send(try inputEvent(request))
        case "type":
          let text = req["text"] as? String ?? ""
          try await input.send(.composite(try TextToHIDEvents.convertTextToHIDEvents(text)))
        case "steps", "drag":
          try await input.send(try inputEvent(req))
        case "lock":
          try await input.send(.shortButtonPress(.lock))
        case "open_url":
          // The link comes on the engine's input, never in an argument (simctl openurl's), which every user of a Mac can read.
          guard let text = req["url"] as? String, let url = URL(string: text), url.scheme != nil else { throw EngineError(message: "url: a link with a scheme") }
          let target = simulator
          try await blocking { _ = try target.open(url).block() }
        case "settle":
          let (waited, updates, settled) = await settle(watcher, quietMs: req["quiet_ms"] as? Double ?? 150, timeoutMs: req["timeout_ms"] as? Double ?? 4000, firstChangeMs: req["first_change_ms"] as? Double ?? 0)
          answer["waited_ms"] = waited; answer["updates"] = updates; answer["settled"] = settled
        case "settle_read":
          // An input (optional), the wait until the screen holds still, and the read: one request (Settle.swift).
          let event = try (req["input"] as? [String: Any]).map(inputEvent)
          lastReadReport = [:]
          lastSerializeMs = []
          let result = try await settleRead(simulator, input: event.map { e in { try await input.send(e); inputSent = true } },
            firstChangeMs: req["first_change_ms"] as? Double ?? 800, quietMs: req["quiet_ms"] as? Double ?? 150, startMs: req["start_ms"] as? Double ?? 50,
            guardMs: req["guard_ms"] as? Double ?? 35, timeoutMs: req["timeout_ms"] as? Double ?? 4000, keys: (req["lean"] as? Bool) == true ? leanKeys : outputKeys,
            fromKept: (req["baseline"] as? String) == "kept")
          for (key, value) in result { answer[key] = value }
          if let scan = lastReadReport["web_scan"] { answer["web_scan"] = scan }
        case "tap_settle_describe":
          // One call for an act: the tap, the wait until the screen stops changing, then the new tree.
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
          lastReadReport = [:]
          try await input.send(.tapAt(x: x, y: y))
          let (waited, updates, settled) = await settle(watcher, quietMs: req["quiet_ms"] as? Double ?? 150, timeoutMs: req["timeout_ms"] as? Double ?? 4000, firstChangeMs: req["first_change_ms"] as? Double ?? 800)
          let readStart = Date()
          // An app still launching reads as an application with nothing in it: wait for content, up to 3 s.
          var tree: Any = []; var reads = 0
          let before = lastTreeSignature
          while true {
            tree = try await readFrontmost(simulator, keys: outputKeys); reads += 1
            // The screen moved but reads as before: the change (an app opening) is not in the tree yet.
            let unchanged = updates > 0 && signature(tree) == before
            if (!isEmptyApp(tree) && !unchanged) || Date().timeIntervalSince(readStart) > 2.5 { break }
            _ = await settle(watcher, quietMs: 150, timeoutMs: 1000, firstChangeMs: 0)
          }
          answer["tree"] = tree; answer["settle_ms"] = waited; answer["updates"] = updates; answer["settled"] = settled; answer["read_ms"] = ms(readStart); answer["reads"] = reads
          if let scan = lastReadReport["web_scan"] { answer["web_scan"] = scan }
        case "watch":
          // Where the screen changes over window_ms, each change as [ms, x, y, width, height] in points (the box
          // around what changed since the frame before; [ms] alone: the seed moved but no pixel did). An optional
          // tap [x, y] first.
          let windowMs = req["window_ms"] as? Double ?? 2000
          guard let surface = watcher.currentSurface() else { throw EngineError(message: "no screen buffer") }
          let reference = PixelReference()
          guard reference.capture(surface) else { throw EngineError(message: "the screen buffer can't be read") }
          var lastSeed = reference.seed
          if let p = req["tap"] as? [Double], p.count == 2 { try await input.send(.tapAt(x: p[0], y: p[1])) }
          let start = Date(); var changes: [[Double]] = []; var diffMs = 0.0, diffs = 0
          while Date().timeIntervalSince(start) * 1000 < windowMs {
            try? await Task.sleep(nanoseconds: 4_000_000)
            guard let seed = watcher.currentSeed(), seed != lastSeed else { continue }
            lastSeed = seed
            let at = Double(ms(start)), d0 = Date()
            let (readable, box) = reference.diff(surface, update: true)
            diffMs += Date().timeIntervalSince(d0) * 1000; diffs += 1
            if !readable { changes.append([at, -1]); _ = reference.capture(surface); continue }
            if let box { changes.append([at] + rectArray(CGRect(x: box.minX / pixelScale, y: box.minY / pixelScale, width: box.width / pixelScale, height: box.height / pixelScale))) }
            else { changes.append([at]) }
          }
          answer["changes"] = changes; answer["diff_ms_avg"] = diffs > 0 ? diffMs / Double(diffs) : 0
        case "tap_trace":
          // When the screen changes after a tap: one timestamp (ms after the tap) per surface change.
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0, windowMs = req["window_ms"] as? Double ?? 3000
          try await input.send(.tapAt(x: x, y: y))
          let start = Date(); var changes: [Int] = []; var last = watcher.snapshot().1
          while Date().timeIntervalSince(start) * 1000 < windowMs {
            try? await Task.sleep(nanoseconds: 5_000_000); watcher.pollSeed()
            let now = watcher.snapshot().1; if now != last { changes.append(ms(start)); last = now }
          }
          answer["changes"] = changes
        case "home":
          // A press, held briefly; if the screen did not change, once more (a press during an app's launch is dropped).
          // With "wait": false only the press (the caller waits for the screen itself).
          for attempt in 0..<((req["wait"] as? Bool) == false ? 1 : 2) {
            if (req["wait"] as? Bool) == false {
              try await input.send(.composite([.button(direction: .down, button: .homeButton), .delay(0.06), .button(direction: .up, button: .homeButton)]))
              break
            }
            try await input.send(.composite([.button(direction: .down, button: .homeButton), .delay(0.06), .button(direction: .up, button: .homeButton)]))
            let (_, updates, _) = await settle(watcher, quietMs: 150, timeoutMs: 3000, firstChangeMs: 600)
            answer["attempts"] = attempt + 1; answer["updates"] = updates
            if updates > 0 { break }
          }
        case "screenshot":
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
            var size: (Double, Double)? = nil
            if let w = req["width"] as? Double, let h = req["height"] as? Double { size = (w, h) }
            let jpg = try jpeg(fromPNG: png, maxPoints: size, quality: req["quality"] as? Double ?? 0.7)
            answer["bytes"] = jpg.count
            if req["path"] as? String != nil { try jpg.write(to: URL(fileURLWithPath: req["path"] as! String)) }
            if req["inline"] as? Bool == true { answer["jpeg_base64"] = jpg.base64EncodedString() }
          }
          answer["capture_ms"] = shotMs
        case "stream":
          // Hardware-encoded video of the screen for N seconds into a file, or into a descriptor the parent holds
          // (fd; the live view's pipe, the engine's stdout once it said ready). seconds 0: until the reader goes or
          // the engine is ended (a write to a closed pipe ends it).
          let seconds = req["seconds"] as? Double ?? 10, fps = req["fps"] as? Double ?? 30
          let codec: FBVideoStreamCodec = (req["codec"] as? String) == "hevc" ? .hevc : .h264
          let transportName = req["transport"] as? String ?? "annexb"
          let transport: FBVideoStreamTransport = transportName == "fmp4" ? .fmp4 : (transportName == "mpegts" ? .mpegts : .annexB)
          let config = FBVideoStreamConfiguration(format: .compressedVideo(withCodec: codec, transport: transport), framesPerSecond: NSNumber(value: fps),
            rateControl: .bitrate(NSNumber(value: req["bitrate"] as? Double ?? 2_000_000)), scaleFactor: NSNumber(value: req["scale"] as? Double ?? 0.5), keyFrameRate: NSNumber(value: req["keyframe_s"] as? Double ?? 2))
          let stream = try await simulator.createStream(configuration: config)
          let fh: FileHandle
          if let fd = req["fd"] as? Int {
            guard fd >= 1, fcntl(Int32(fd), F_GETFD) != -1 else { throw EngineError(message: "fd \(fd) is not open") }
            fh = FileHandle(fileDescriptor: Int32(fd), closeOnDealloc: false)
          } else {
            let path = req["path"] as? String ?? "/tmp/sue-stream.bin"
            FileManager.default.createFile(atPath: path, contents: nil)
            guard let file = FileHandle(forWritingAtPath: path) else { throw EngineError(message: "cannot write \(path)") }
            fh = file
          }
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
        default:
          throw EngineError(message: "unknown op \(op)")
        }
        for (key, value) in input.report() { answer[key] = value }
        answer["ms"] = ms(t0); answer["bootstraps"] = bootstrapCount; answer["sessions"] = sessionsOpened
        if let failure = lastBootstrapError { answer["bootstrap_error"] = failure; lastBootstrapError = nil }
        emit(answer)
      } catch {
        // input_sent: any of the request's input may have reached the phone; it must not be sent again another way.
        var failed: [String: Any] = ["id": id, "ok": false, "ms": ms(t0), "error": (error as? EngineError)?.message ?? String(describing: error), "input_sent": inputSent || input.sent]
        for (key, value) in input.report() { failed[key] = value }
        emit(failed)
      }
    }
    closeSession()
    exit(0)
  } catch {
    emit(["ready": false, "error": (error as? EngineError)?.message ?? String(describing: error)])
    exit(1)
  }
}
Task { await main() }
RunLoop.main.run()
