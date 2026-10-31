// Reading the screen once it holds still, and not reading it again while it does.
//
// "Still" is read from the screen buffer: where it changed (Frames.swift), not only that it did, so a caret blinking
// in a text field is not a screen that keeps changing. A read is kept only when the screen held still through it
// and a moment after (a change that lands as the read runs is drawn a frame or two later), so the read the caller
// gets is the screen as it is, and that read can be given again while the screen's pixels stay as they were.
import Foundation
import CoreGraphics
import IOSurface
import FBControlCore
import FBSimulatorControl

/** A caret is about 2 points wide; with its antialiasing a blink changes at most this wide a band. */
let caretMaxWidth: CGFloat = 4.5
let caretMaxHeight: CGFloat = 60

/** Where a caret can blink: the text fields of the last screen read, in screen points. */
var caretZones: [CGRect] = [] { didSet { writeClock?.setZones(caretZones) } }
/** When accessibility was last reloaded for an app. */
var lastReloadAt = Date.distantPast

/**
 * The seed clock's other half: when the screen was last written to in a way that counts, a caret's blink aside. On
 * each seed change it looks at where the screen changed, unless the screen is plainly moving (a change within 50 ms
 * of a change that counted: an animation is not looked at frame by frame, it simply counts).
 */
final class WriteClock: @unchecked Sendable {
  private let lock = NSLock()
  private let reference = PixelReference()
  private var surface: IOSurface?
  private var seed: UInt32 = 0
  private var zones: [CGRect] = []
  private var lastWrite = Date.distantPast
  private var lastSignificant = Date()
  /** The last change was looked at and did not count (or the reference is current): look at the next one too. */
  private var lookNext = true

  func setZones(_ frames: [CGRect]) { lock.lock(); zones = frames; lock.unlock() }

  func tick(_ current: IOSurface?) {
    guard let current else { return }
    lock.lock(); defer { lock.unlock() }
    let now = Date()
    if surface !== current {
      surface = current
      _ = reference.capture(current); seed = reference.seed
      lastWrite = now; lastSignificant = now; lookNext = true
      return
    }
    let next = surfaceSeed(current)
    guard next != seed else { return }
    seed = next
    let gap = now.timeIntervalSince(lastWrite)
    lastWrite = now
    guard lookNext || gap >= 0.05 else { lastSignificant = now; return }
    let (readable, box) = reference.diff(current, update: true)
    seed = reference.seed
    if !readable { _ = reference.capture(current); seed = reference.seed; lastSignificant = now; lookNext = false; return }
    if let box, !caretOnly(box, zones: zones) { lastSignificant = now; lookNext = false } else { lookNext = true }
  }

  /** Seconds since the screen last changed in a way that counts. */
  func sinceSignificantWrite() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(lastSignificant) }
}
var writeClock: WriteClock?

func textFieldFrames(_ tree: Any) -> [CGRect] {
  var out: [CGRect] = []
  func walk(_ node: Any) {
    if let list = node as? [Any] { list.forEach(walk); return }
    guard let n = node as? [String: Any] else { return }
    if let role = n["role"] as? String, ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField"].contains(role), let f = frameOf(n), f.width > 0, f.height > 0 { out.append(f) }
    (n["children"] as? [Any])?.forEach(walk)
  }
  walk(tree)
  return out
}

/** A changed box (pixels) that is only a caret: a thin upright band inside a text field. */
func caretOnly(_ box: CGRect, zones: [CGRect]) -> Bool {
  let p = CGRect(x: box.minX / pixelScale, y: box.minY / pixelScale, width: box.width / pixelScale, height: box.height / pixelScale)
  guard p.width <= caretMaxWidth, p.height <= caretMaxHeight else { return false }
  return zones.contains { $0.insetBy(dx: -4, dy: -4).contains(p) }
}

func surfaceSeed(_ surface: IOSurface) -> UInt32 { IOSurfaceGetSeed(unsafeBitCast(surface, to: IOSurfaceRef.self)) }

/** Follows the screen buffer from a moment on: whether it changed since the last look, a caret's blink aside. */
final class ChangeTracker {
  private(set) var surface: IOSurface
  let reference: PixelReference
  /** Where a caret's blink does not count: the text fields of the screen as last read (updated by each read). */
  var zones: [CGRect]
  private var seed: UInt32
  /** The last change that counted, as a box in points (for the caller's report). */
  private(set) var lastBox: CGRect?

  init?(zones: [CGRect], reference given: PixelReference? = nil) {
    guard let surface = screenWatcher?.surface else { return nil }
    self.surface = surface
    self.zones = zones
    if let given, given.valid {
      reference = given
    } else {
      reference = PixelReference()
      guard reference.capture(surface) else { return nil }
    }
    seed = reference.seed
  }

  /** Whether the screen changed in a way that counts since the last call; the reference then becomes the screen now. */
  func changed() -> Bool {
    // The simulator gave the screen another buffer: everything may have changed, and the new one is followed.
    if let now = screenWatcher?.surface, now !== surface {
      surface = now
      _ = reference.capture(now); seed = reference.seed
      lastBox = nil
      return true
    }
    let now = surfaceSeed(surface)
    if now == seed { return false }
    let (readable, box) = reference.diff(surface, update: true)
    seed = reference.seed
    guard readable else { _ = reference.capture(surface); seed = reference.seed; return true }
    guard let box else { return false }
    if caretOnly(box, zones: zones) { return false }
    lastBox = CGRect(x: box.minX / pixelScale, y: box.minY / pixelScale, width: box.width / pixelScale, height: box.height / pixelScale)
    return true
  }
}

/** The last read that can be given again: taken while the screen held still, with the screen's pixels at the time. */
struct KeptRead {
  let tree: Any
  let at: Date
  let pixels: PixelReference
  let surface: IOSurface
  let zones: [CGRect]
  let options: String
}
var keptRead: KeptRead?

/** What a read was asked with: a kept read is given again only for the same request. */
func readOptions(keys: Set<FBAXKeys>, nested: Bool) -> String {
  "\(keys.map(\.rawValue).sorted().joined(separator: ","))|\(nested)|\(webScanOn)|\(webBudget)|\(readRemote != nil)|\(readProfile)"
}

/**
 * A few points of the kept read's screen, read again one point each (a few milliseconds): it is given again only when
 * what the phone says is at each point is an element the kept read has there, with the same label, value, id, role
 * and frame. The points: up to two text fields (their text), and the top, bottom and middle labelled leaves. A hit
 * test answers the element that takes a touch there (a tab's button, not its icon), so any element of the kept read
 * at that point may be the answer. Nil when all agree, else what differed.
 */
@MainActor
func spotCheck(_ simulator: FBSimulator, _ tree: Any) async -> String? {
  var all: [[String: Any]] = []
  func walk(_ node: Any) {
    if let list = node as? [Any] { list.forEach(walk); return }
    guard let n = node as? [String: Any] else { return }
    all.append(n)
    (n["children"] as? [Any])?.forEach(walk)
  }
  walk(tree)
  let onDisplay = { (f: CGRect) in f.width >= 4 && f.height >= 4 && f.midX > 0 && f.midY > 0 && (display.width == 0 || (f.midX < display.width && f.midY < display.height)) }
  let fields = all.filter { ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField"].contains($0["role"] as? String ?? "") && frameOf($0).map(onDisplay) == true }
  let leaves = all.filter { (($0["children"] as? [Any]) ?? []).isEmpty && !(($0["AXLabel"] as? String) ?? "").isEmpty && frameOf($0).map(onDisplay) == true }
    .sorted { (frameOf($0)?.midY ?? 0) < (frameOf($1)?.midY ?? 0) }
  // At most four: two fields, the top and bottom labelled leaves, and the middle one while there is room.
  var probes = Array(fields.prefix(2))
  if !leaves.isEmpty { probes.append(leaves[0]); if leaves.count > 1 { probes.append(leaves[leaves.count - 1]) } }
  if leaves.count > 2 && probes.count < 4 { probes.append(leaves[leaves.count / 2]) }
  let text = { (n: [String: Any], key: String) in n[key].map { "\($0)" } ?? "" }
  let same = { (a: [String: Any], b: [String: Any]) -> Bool in
    guard ["AXLabel", "AXValue", "AXUniqueId", "role"].allSatisfy({ text(a, $0) == text(b, $0) }), let fa = frameOf(a), let fb = frameOf(b) else { return false }
    return abs(fa.minX - fb.minX) <= 1.5 && abs(fa.minY - fb.minY) <= 1.5 && abs(fa.width - fb.width) <= 1.5 && abs(fa.height - fb.height) <= 1.5
  }
  for probe in probes {
    guard let f = frameOf(probe) else { return "no frame" }
    let point = CGPoint(x: f.midX, y: f.midY)
    guard let hit = (await rawHit(simulator, Double(point.x), Double(point.y))).map({ onScreen($0, at: point) }) as? [String: Any] else { return "nothing at \(text(probe, "AXLabel").prefix(40))" }
    let there = all.filter { frameOf($0)?.insetBy(dx: -1, dy: -1).contains(point) == true }
    if !there.contains(where: { same($0, hit) }) {
      let describe = { (n: [String: Any]) in "\(text(n, "role")) \(text(n, "AXLabel").prefix(30)) =\(text(n, "AXValue").prefix(20)) #\(text(n, "AXUniqueId").prefix(20)) \(frameOf(n).map { rectArray($0) } ?? [])" }
      let near = there.first { text($0, "AXLabel") == text(hit, "AXLabel") } ?? there.last
      return "\(describe(hit)) at \(Int(point.x)),\(Int(point.y)), kept: \(near.map(describe) ?? "nothing")"
    }
  }
  return nil
}

/**
 * A read of the screen that is kept for giving again when the screen held still for a moment before it and through
 * it (stillBefore: no change for that long, a caret aside; settle's reads know it, a plain read asks the seed clock).
 */
@MainActor
func trackedRead(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool, stillBefore: Bool) async throws -> (tree: Any, kept: String) {
  let tracker = ChangeTracker(zones: caretZones)
  let options = readOptions(keys: keys, nested: nested)
  let tree = try await readFrontmost(simulator, keys: keys, nested: nested)
  caretZones = textFieldFrames(tree)
  // Why the read is kept for giving again, or why not.
  let why = tracker == nil ? "no screen buffer" : !stillBefore ? "moving before" : tracker!.changed() ? "moving during" : isEmptyApp(tree) ? "empty"
    : !lastReadStable ? "reloaded, not yet whole" : "kept"
  keptRead = why == "kept" ? KeptRead(tree: tree, at: Date(), pixels: tracker!.reference, surface: tracker!.surface, zones: caretZones, options: options) : nil
  return (tree, why)
}

/** The kept read, when the screen's pixels are as they were then (a caret aside) and its spot checks agree; why, or nil. */
@MainActor
func reusableRead(_ simulator: FBSimulator, keys: Set<FBAXKeys>, nested: Bool, maxAge: TimeInterval) async -> (tree: Any?, why: String) {
  guard let kept = keptRead else { return (nil, "none kept") }
  guard kept.options == readOptions(keys: keys, nested: nested) else { return (nil, "asked otherwise") }
  guard Date().timeIntervalSince(kept.at) <= maxAge else { return (nil, "too old") }
  guard screenWatcher?.surface === kept.surface else { return (nil, "another screen buffer") }
  var why: String
  if surfaceSeed(kept.surface) == kept.pixels.seed { why = "seed" }
  else {
    let (readable, box) = kept.pixels.diff(kept.surface, update: false)
    guard readable else { return (nil, "unreadable buffer") }
    if box == nil { why = "pixels" }
    else if let box, caretOnly(box, zones: kept.zones) { why = "caret" }
    else { return (nil, "changed \(box.map { rectArray(CGRect(x: $0.minX / pixelScale, y: $0.minY / pixelScale, width: $0.width / pixelScale, height: $0.height / pixelScale)) } ?? [])") }
  }
  if let failed = await spotCheck(simulator, kept.tree) { keptRead = nil; return (nil, "spot check: \(failed)") }
  return (kept.tree, why)
}

/**
 * Sends an input (optional), then waits for the screen to change (up to firstChangeMs; 0: it is taken as changing
 * already) and to hold still, and reads it. A read starts once the screen has held still for startMs, and counts
 * only if nothing changed while it ran and for guardMs after, and the screen has been still for quietMs in all;
 * otherwise it is dropped and the wait goes on. Past timeoutMs the screen is read as it is (settled false).
 * baseline "kept": what counts as a change is a difference from the kept read's screen (a change that came just
 * before this request), else from the screen as the request starts.
 */
@MainActor
func settleRead(_ simulator: FBSimulator, input: (() async throws -> Void)?, firstChangeMs: Double, quietMs: Double, startMs: Double, guardMs: Double,
                timeoutMs: Double, keys: Set<FBAXKeys>, fromKept: Bool) async throws -> [String: Any] {
  let t0 = Date()
  func elapsed() -> Double { Date().timeIntervalSince(t0) * 1000 }
  // Any input makes the kept read the past; as the baseline, its pixels are the screen the caller last saw.
  let kept = keptRead
  keptRead = nil
  let baseline = fromKept && kept != nil && screenWatcher?.surface === kept!.surface ? kept!.pixels : nil
  guard let tracker = ChangeTracker(zones: caretZones, reference: baseline) else {
    // No screen buffer to watch (never seen on iOS 26 or 27): the input, the seed's wait as before, and a read.
    try await input?()
    var settled = true
    if let watcher = screenWatcher { settled = await settle(watcher, quietMs: quietMs, timeoutMs: timeoutMs, firstChangeMs: firstChangeMs).2 }
    let tree = try await readFrontmost(simulator, keys: keys)
    caretZones = textFieldFrames(tree)
    return ["tree": tree, "settled": settled, "changed": true, "waited_ms": Int(elapsed()), "reads": 1, "dropped": 0, "watched": false]
  }
  // The waits count from the end of the input: a hold or a slow drag takes a second or more to send.
  try await input?()
  let inputEnd = elapsed()
  var lastChange: Double? = nil
  var firstChangeAt = -1.0
  if firstChangeMs <= 0 {
    // Taken as changing already: still for as long as the seed clock has seen no write (a caret's blink included).
    let still = (writeClock?.sinceSignificantWrite() ?? 0) * 1000
    lastChange = inputEnd - min(max(0, still), quietMs)
  } else if tracker.changed() {
    lastChange = elapsed(); firstChangeAt = lastChange!
  }
  while lastChange == nil && elapsed() - inputEnd < firstChangeMs {
    try? await Task.sleep(nanoseconds: 4_000_000)
    if tracker.changed() { lastChange = elapsed(); firstChangeAt = lastChange! }
  }
  var reads = 0, dropped = 0, readMs: [Int] = []
  func finish(_ tree: Any, settled: Bool, changed: Bool, kept: Bool) -> [String: Any] {
    caretZones = textFieldFrames(tree)
    if kept && !isEmptyApp(tree) && lastReadStable {
      keptRead = KeptRead(tree: tree, at: Date(), pixels: tracker.reference, surface: tracker.surface, zones: caretZones, options: readOptions(keys: keys, nested: true))
    } else {
      keptRead = nil
    }
    var answer: [String: Any] = ["tree": tree, "settled": settled, "changed": changed, "waited_ms": Int(elapsed()), "reads": reads, "dropped": dropped, "read_ms": readMs,
                                 "first_change_ms": Int(firstChangeAt), "kept": kept, "watched": true]
    if let box = tracker.lastBox { answer["last_change"] = rectArray(box) }
    return answer
  }
  var last: Double
  if let changed = lastChange {
    last = changed
  } else {
    // Nothing changed: the screen as it is, held still all along.
    let start = Date()
    let tree = try await readFrontmost(simulator, keys: keys); reads += 1; readMs.append(ms(start))
    tracker.zones = textFieldFrames(tree)
    // Kept only after a wait long enough to know the screen was still (a late check's last few milliseconds are not).
    if !tracker.changed() { return finish(tree, settled: true, changed: false, kept: elapsed() - inputEnd >= 100) }
    // The change came as the screen was read (a late answer): wait for it to hold still, as for any change.
    last = elapsed(); firstChangeAt = last; dropped += 1
  }
  while true {
    if elapsed() - inputEnd >= timeoutMs {
      let start = Date()
      let tree = try await readFrontmost(simulator, keys: keys); reads += 1; readMs.append(ms(start))
      return finish(tree, settled: false, changed: true, kept: false)
    }
    try? await Task.sleep(nanoseconds: 4_000_000)
    if tracker.changed() { last = elapsed(); continue }
    // A screen that keeps changing just after each read starts (a fast ticker) is read only after a full quiet period.
    guard elapsed() - last >= (dropped >= 2 ? quietMs : startMs) else { continue }
    // Still for startMs: read, and keep the read only if the screen stays still through it and guardMs after.
    let start = Date()
    let tree = try await readFrontmost(simulator, keys: keys); reads += 1; readMs.append(ms(start))
    // The fields of the screen as just read: a caret blinking in one (on a screen come back to) is no change.
    tracker.zones = textFieldFrames(tree)
    if tracker.changed() { last = elapsed(); dropped += 1; continue }
    let readEnd = elapsed()
    var moved = false
    while elapsed() - readEnd < guardMs || elapsed() - last < quietMs {
      try? await Task.sleep(nanoseconds: 4_000_000)
      if tracker.changed() { moved = true; break }
    }
    if moved { last = elapsed(); dropped += 1; continue }
    return finish(tree, settled: true, changed: true, kept: true)
  }
}
