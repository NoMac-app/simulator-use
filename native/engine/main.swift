// simulator-use engine (prototype): one process per booted Simulator that loads CoreSimulator's
// private frameworks, the HID connection and the accessibility translator once, then answers JSON
// requests, one per line on stdin, one JSON answer per line on stdout. Built on AXe's
// FBSimulatorControl frameworks (MIT).
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import FBControlCore
import FBSimulatorControl

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
 FBSimulatorControl bootstraps accessibility (a short-lived XCTest remote automation session) before every
 accessibility request on iOS 27 runtimes. A per-call CLI needs that; a long-lived engine needs it once per
 phone: repeated sessions pile up in the phone's testmanagerd, slow every read and finally time out.
 This replaces the class method with one that runs the original once and then reports success.
 */
/**
 iOS 27 Simulators read accessibility only while an XCTest "remote automation session" has loaded it, and an
 app launched afterwards is unreadable until it is loaded again. FBSimulatorControl opens a session, loads
 accessibility and closes the session before every request; in a long-lived process new sessions soon time out.
 The engine instead opens one session per phone, keeps it for its whole life, and reloads accessibility on that
 same session when the frontmost app reads empty (forceBootstrap). The framework's per-request bootstrap is
 replaced by this.
 */
var bootstrapCount = 0
var signalSources: [DispatchSourceSignal] = []
var forceBootstrap = false
var automationSession: AnyObject?
var skipBootstrap = CommandLine.arguments.contains("--no-bootstrap")
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
func openSession(device: AnyObject, timeout: Double) -> (AnyObject?, String?) {
  sessionTurnMs = takeSessionTurn()
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
  unsafeBitCast(objcCall(sessionClass, "requestSessionWithDaemonConnectionProvider:completion:"), to: RequestFn.self)(sessionClass, NSSelectorFromString("requestSessionWithDaemonConnectionProvider:completion:"), provider, completion as AnyObject)
  if done.wait(timeout: .now() + timeout) == .timedOut { outcome = "timed out"; return (nil, "timed out creating the remote automation session") }
  guard let session else { return (nil, failure ?? "no session") }
  typealias EnableFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> Bool
  if session.responds(to: NSSelectorFromString("enableAutomationModeWithError:")) {
    var error: NSError?
    if !unsafeBitCast(objcCall(session, "enableAutomationModeWithError:"), to: EnableFn.self)(session, NSSelectorFromString("enableAutomationModeWithError:"), &error) { return (nil, "automation mode: \(error?.localizedDescription ?? "refused")") }
  }
  outcome = "ok"
  return (session, nil)
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
/** The lock for one open or close (another engine's open can take up to half a minute). */
func lockSessionTurn(maxWait: TimeInterval) {
  let start = Date()
  if sessionLockFD < 0 { sessionLockFD = open(sessionLockPath(), O_CREAT | O_RDWR, 0o600) }
  guard sessionLockFD >= 0 else { return }
  while flock(sessionLockFD, LOCK_EX | LOCK_NB) != 0 && Date().timeIntervalSince(start) < maxWait { usleep(50_000) }
}
func unlockSessionTurn() { if sessionLockFD >= 0 { flock(sessionLockFD, LOCK_UN) } }
/** Before a session is opened: the lock, then the gap since the last close. Returns the ms waited. */
func takeSessionTurn() -> Int {
  let start = Date()
  lockSessionTurn(maxWait: 60)
  let wait = lastSessionClose() + sessionGapSeconds - Date().timeIntervalSince1970
  if wait > 0 { usleep(UInt32(min(wait, sessionGapSeconds) * 1_000_000)) }
  return ms(start)
}
func closeSession() {
  guard let session = automationSession else { return }
  automationSession = nil
  lockSessionTurn(maxWait: 10)
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
typealias BootstrapIMP = @convention(c) (AnyClass, Selector, AnyObject, Double, AnyObject?, UnsafeMutablePointer<NSError?>?) -> Bool
var lastBootstrapError: String?
func installPersistentBootstrap() {
  let cls: AnyClass = FBSimulatorControlFrameworkLoader.self
  let sel = NSSelectorFromString("bootstrapAccessibilityForSimulatorDevice:timeout:logger:error:")
  guard let method = class_getClassMethod(cls, sel) else { return }
  let original = unsafeBitCast(method_getImplementation(method), to: BootstrapIMP.self)
  let block: @convention(block) (AnyClass, AnyObject, Double, AnyObject?, UnsafeMutablePointer<NSError?>?) -> Bool = { klass, device, timeout, logger, errorOut in
    if skipBootstrap { return true }
    if let session = automationSession {
      if !forceBootstrap { return true }
      bootstrapCount += 1; forceBootstrap = false
      if let failure = loadAccessibility(session, timeout: 10) { lastBootstrapError = failure; return true }
      return true
    }
    // The first time: the framework's own bootstrap loads the XCTest frameworks; then our session stays open.
    bootstrapCount += 1
    // The XCTest frameworks the session needs, loaded the framework's way, without its throwaway session.
    var loaded = false
    if let loader = (FBSimulatorControlFrameworkLoader.self as AnyObject).perform(NSSelectorFromString("accessibilityAutomationFrameworks"))?.takeUnretainedValue() as? FBSimulatorControlFrameworkLoader {
      loaded = (try? loader.loadPrivateFrameworks(logger as? FBControlCoreLogger)) != nil
    }
    if !loaded { _ = original(klass, sel, device, max(timeout, 20), logger, errorOut) }
    var (session, failure) = openSession(device: device, timeout: 12)
    if session == nil {
      // A phone that refuses sessions (after one opened too soon after another closed it refuses them for good)
      // takes them again once its test daemon is restarted: no reboot, the apps stay as they are (measured).
      sessionLog("refused: the phone's test daemons restarted"); restartTestDaemons(); sessionRecoveries += 1
      (session, failure) = openSession(device: device, timeout: 20)
    }
    guard let session else { lastBootstrapError = failure; return false }
    if let failure = loadAccessibility(session, timeout: 10) { lastBootstrapError = failure }
    automationSession = session; forceBootstrap = false
    return true
  }
  method_setImplementation(method, imp_implementationWithBlock(block))
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
/** An element's frame: FBSimulatorControl's "frame" dictionary, or its "AXFrame" string. */
func frameOf(_ node: [String: Any]) -> CGRect? {
  if let f = node["frame"] as? [String: Any], let x = f["x"] as? Double, let y = f["y"] as? Double, let w = f["width"] as? Double, let h = f["height"] as? Double {
    return CGRect(x: x, y: y, width: w, height: h)
  }
  if let text = node["AXFrame"] as? String { return NSRectFromString(text) }
  return nil
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
      var hit: [String: Any]? = nil
      if let element = try? await simulator.accessibilityElement(at: CGPoint(x: x, y: y)) {
        hit = (try? element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: false, keys: outputKeys)).elements).map(withDefaults) as? [String: Any]
        element.close()
      }
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
    var hit: [String: Any]? = nil
    if let element = try? await simulator.accessibilityElement(at: point) {
      hit = (try? element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: false, keys: outputKeys)).elements).map(withDefaults) as? [String: Any]
      element.close()
    }
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
func serializeFrontmost(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool) async throws -> Any {
  let start = Date()
  let element = try await simulator.accessibilityElementForFrontmostApplication()
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
  var reloaded = false
  lastSerializeMs = []
  for attempt in 0..<2 {
    do {
      var tree = try await serializeFrontmost(simulator, keys: keys, nested: nested)
      if attempt == 0 && isEmptyApp(tree) { forceBootstrap = true; reloaded = true; continue }
      // After accessibility was reloaded (an app that read empty), its elements fill in over a moment: read again
      // until two reads agree, up to 2 s. A newly opened app is read again by simulator-use (opening() in
      // src/look/read.ts); the pid comparison that once did it here never fired (pids came back nil), and every
      // measurement of the day was made without it, so it stays off.
      if reloaded {
        let start = Date()
        while Date().timeIntervalSince(start) < 2 {
          try? await Task.sleep(nanoseconds: 250_000_000)
          let next = try await serializeFrontmost(simulator, keys: keys, nested: nested)
          let same = signature(next) == signature(tree)
          tree = next
          // Two equal reads of a nearly empty app are its shell before the content: not settled yet.
          if same && !isEmptyApp(tree) && nodeCount(tree) >= 12 { break }
        }
      }
      lastFrontPid = intValue((tree as? [[String: Any]])?.first?["pid"]) ?? -1
      if webScanOn { tree = await withWebContent(simulator, tree) }
      lastTreeSignature = signature(tree)
      return tree
    } catch {
      if attempt == 0 && String(describing: error).contains("No translation object") { forceBootstrap = true; continue }
      throw error
    }
  }
  return []
}
@MainActor
func main() async {
  do {
    try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
    try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
    if !args.contains("--bootstrap-every-call") { installPersistentBootstrap() }
    let control = try FBSimulatorControl.withConfiguration(FBSimulatorControlConfiguration(deviceSetPath: deviceSetPath, logger: logger, reporter: nil))
    guard let simulator = control.set.allSimulators.first(where: { $0.udid == udid }) else { throw EngineError(message: "no simulator \(udid)") }
    guard simulator.state == .booted else { throw EngineError(message: "simulator \(udid) is not booted") }
    let loaded = ms(started)
    let hidStart = Date()
    let hid = try await simulator.connectToHID()
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
    emit(["ready": true, "load_ms": loaded, "hid_ms": ms(hidStart), "framebuffer_ms": ms(fbStart), "framebuffer": framebuffer != nil, "surface": surface != nil, "name": simulator.name, "screen": screen])

    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { closeSession(); exit(0) }
      source.resume(); signalSources.append(source)
    }
    while let line = readLine() {
      let t0 = Date()
      guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let op = req["op"] as? String else { emit(["ok": false, "error": "bad request"]); continue }
      let id = req["id"] ?? NSNull()
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
          }
          readRemote = remoteOptions(req["remote"]); readProfile = (req["profile"] as? Bool) ?? false; lastReadReport = [:]
          webScanOn = (req["web"] as? Bool) ?? true; webBudget = (req["web_budget_ms"] as? Double).map { $0 / 1000 } ?? 2.5
          defer { readRemote = nil; readProfile = false; webScanOn = true; webBudget = 2.5 }
          answer["tree"] = try await readFrontmost(simulator, keys: keys, nested: (req["nested"] as? Bool) ?? true)
          answer["cpu_ms"] = cpuMs(); answer["serialize_ms"] = lastSerializeMs
          if sessionTurnMs > 0 { answer["session_wait_ms"] = sessionTurnMs; sessionTurnMs = 0 }
          if sessionRecoveries > 0 { answer["session_recoveries"] = sessionRecoveries }
          for (key, value) in lastReadReport { answer[key] = value }
        case "point":
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
          for attempt in 0..<2 {
            do {
              let element = try await simulator.accessibilityElement(at: CGPoint(x: x, y: y))
              defer { element.close() }
              // nested: the element with everything under it (a hit on a web page's background is the page).
              answer["element"] = withDefaults(try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: (req["nested"] as? Bool) ?? false, keys: outputKeys)).elements)
              break
            } catch {
              if attempt == 0 && String(describing: error).contains("No translation object") { forceBootstrap = true; continue }
              throw error
            }
          }
        case "tap":
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
          try await hid.send(event: .tapAt(x: x, y: y), logger: logger)
        case "swipe":
          let x1 = req["x1"] as? Double ?? 0, y1 = req["y1"] as? Double ?? 0, x2 = req["x2"] as? Double ?? 0, y2 = req["y2"] as? Double ?? 0
          try await hid.send(event: .swipe(x1, yStart: y1, xEnd: x2, yEnd: y2, delta: req["delta"] as? Double ?? 10, duration: req["duration"] as? Double ?? 0.3), logger: logger)
        case "type":
          let text = req["text"] as? String ?? ""
          try await hid.send(event: .composite(try TextToHIDEvents.convertTextToHIDEvents(text)), logger: logger)
        case "steps":
          // simulator-use's input batch, as one HID composite: [{"tap":[x,y]}, {"sleep":s}, {"key":code},
          // {"combo":{"mods":[codes],"key":code}}, {"type":"text"}, {"touch":[x,y],"hold":s}].
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
          try await hid.send(event: .composite(events), logger: logger)
        case "drag":
          // A finger put down, moved in steps and lifted (sliders, reordering); a swipe is a quick drag.
          let x1 = req["x1"] as? Double ?? 0, y1 = req["y1"] as? Double ?? 0, x2 = req["x2"] as? Double ?? 0, y2 = req["y2"] as? Double ?? 0
          let duration = req["duration"] as? Double ?? 0.6, n = max(1, Int(req["steps"] as? Double ?? 20))
          var events: [FBSimulatorHIDEvent] = [.touch(direction: .down, x: x1, y: y1), .delay(req["hold"] as? Double ?? 0.05)]
          for i in 1...n { let f = Double(i) / Double(n); events += [.delay(duration / Double(n)), .touch(direction: .down, x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f)] }
          events.append(.touch(direction: .up, x: x2, y: y2))
          try await hid.send(event: .composite(events), logger: logger)
        case "lock":
          try await hid.send(event: .shortButtonPress(.lock), logger: logger)
        case "open_url":
          // The link comes on the engine's input, never in an argument (simctl openurl's), which every user of a Mac can read.
          guard let text = req["url"] as? String, let url = URL(string: text), url.scheme != nil else { throw EngineError(message: "url: a link with a scheme") }
          let target = simulator
          try await blocking { _ = try target.open(url).block() }
        case "settle":
          let (waited, updates, settled) = await settle(watcher, quietMs: req["quiet_ms"] as? Double ?? 150, timeoutMs: req["timeout_ms"] as? Double ?? 4000, firstChangeMs: req["first_change_ms"] as? Double ?? 0)
          answer["waited_ms"] = waited; answer["updates"] = updates; answer["settled"] = settled
        case "tap_settle_describe":
          // One call for an act: the tap, the wait until the screen stops changing, then the new tree.
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
          lastReadReport = [:]
          try await hid.send(event: .tapAt(x: x, y: y), logger: logger)
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
        case "tap_trace":
          // When the screen changes after a tap: one timestamp (ms after the tap) per surface change.
          let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0, windowMs = req["window_ms"] as? Double ?? 3000
          try await hid.send(event: .tapAt(x: x, y: y), logger: logger)
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
              try await hid.send(event: .composite([.button(direction: .down, button: .homeButton), .delay(0.06), .button(direction: .up, button: .homeButton)]), logger: logger)
              break
            }
            try await hid.send(event: .composite([.button(direction: .down, button: .homeButton), .delay(0.06), .button(direction: .up, button: .homeButton)]), logger: logger)
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
        answer["ms"] = ms(t0); answer["bootstraps"] = bootstrapCount
        if let failure = lastBootstrapError { answer["bootstrap_error"] = failure; lastBootstrapError = nil }
        emit(answer)
      } catch {
        emit(["id": id, "ok": false, "ms": ms(t0), "error": (error as? EngineError)?.message ?? String(describing: error)])
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
