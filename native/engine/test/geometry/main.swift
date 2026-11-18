// The engine's screen geometry (Geometry.swift), checked with any Swift and no Simulator:
//   swiftc -o /tmp/geometry-test native/engine/Geometry.swift native/engine/Stills.swift native/engine/test/geometry/main.swift && /tmp/geometry-test
// Each turn is checked three ways that must agree: a touch's fraction (AXe's mapping), a buffer pixel's place in the
// drawn picture, and the picture Core Image draws with drawnTransform (a 3x2 image whose every pixel is its own color).
import CoreGraphics
import CoreImage
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL \(what)") } }
func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 1e-9 }

// The Duo's inner screen: 2007x2853 pixels, 3 to a point.
for rotation in [0, 90, 180, 270] {
  let g = ScreenGeometry(native: CGSize(width: 2007, height: 2853), scale: 3, rotation: rotation)
  let turned = rotation % 180 != 0
  check(g.points == (turned ? CGSize(width: 951, height: 669) : CGSize(width: 669, height: 951)), "points at \(rotation)")
  check(g.orientation == (turned ? "landscape" : "portrait"), "orientation at \(rotation)")
  // A point of the drawn interface, to the panel's fraction and back through the panel's pixels.
  for p in [CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 20), CGPoint(x: g.points.width, y: g.points.height), CGPoint(x: 333.3, y: 111.1)] {
    let n = g.normalized(p)
    let back = g.logical(nativePixel: n.x * g.native.width, n.y * g.native.height)
    check(near(back.x, p.x) && near(back.y, p.y), "round trip \(p) at \(rotation): \(back)")
    let native = g.nativePoint(p)
    check(near(native.x, n.x * 669) && near(native.y, n.y * 951), "native point \(p) at \(rotation)")
  }
  // A box of buffer pixels lands where its corners do.
  let r = g.logicalRect(nativePixels: CGRect(x: 30, y: 60, width: 3, height: 90))
  check(near(r.width * r.height, 1 * 30), "box area at \(rotation): \(r)")
  check(near(r.width, turned ? 30 : 1), "a thin band stays thin, turned with the interface, at \(rotation): \(r)")
}
// Outside the screen a fraction is clamped to its edge (a touch never goes to another screen).
let outer = ScreenGeometry(native: CGSize(width: 1398, height: 2034), scale: 3, rotation: 0)
check(outer.normalized(CGPoint(x: -5, y: 9999)) == CGPoint(x: 0, y: 1), "clamped")

// Core Image's picture: a 3x2 buffer (pixel (u, v) has red u*80, green v*120) drawn with drawnTransform.
let bytes: [UInt8] = (0..<2).flatMap { v in (0..<3).flatMap { u in [UInt8(u * 80), UInt8(v * 120), 0, 255] } }
let source = CIImage(bitmapData: Data(bytes), bytesPerRow: 12, size: CGSize(width: 3, height: 2), format: .RGBA8, colorSpace: nil)
let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
for rotation in [0, 90, 180, 270] {
  let g = ScreenGeometry(native: CGSize(width: 3, height: 2), scale: 1, rotation: rotation)
  let image = source.transformed(by: g.drawnTransform)
  let size = g.drawnPixels
  check(image.extent == CGRect(origin: .zero, size: size), "extent at \(rotation): \(image.extent)")
  var out = [UInt8](repeating: 0, count: Int(size.width * size.height) * 4)
  context.render(image, toBitmap: &out, rowBytes: Int(size.width) * 4, bounds: CGRect(origin: .zero, size: size), format: .RGBA8, colorSpace: nil)
  // render's rows run bottom to top in Core Image's coordinates: row 0 of the bitmap is the picture's top.
  for y in 0..<Int(size.height) {
    for x in 0..<Int(size.width) {
      let i = (y * Int(size.width) + x) * 4
      let u = Int(out[i]) / 80, v = Int(out[i + 1]) / 120
      // Where buffer pixel (u, v)'s center lands in the drawn picture, top left origin.
      let at = g.logical(nativePixel: CGFloat(u) + 0.5, CGFloat(v) + 0.5)
      check(Int(at.x) == x && Int(at.y) == y, "pixel (\(u),\(v)) drawn at (\(x),\(y)) at \(rotation), mapped to \(at)")
    }
  }
}
let canvas = recordingCanvas([outer, ScreenGeometry(native: CGSize(width: 2007, height: 2853), scale: 3, rotation: 0)], scale: 1, turns: true)
check(canvas == CGSize(width: 2852, height: 2852), "canvas \(canvas)")
check(recordingCanvas([outer], scale: 0.5, turns: false) == CGSize(width: 698, height: 1016), "one screen's canvas")
check(centered(CGSize(width: 1398, height: 2034), on: CGSize(width: 2852, height: 2852), scale: 1) == CGRect(x: 727, y: 409, width: 1398, height: 2034), "centered")
check(postureName(degrees: 0) == "closed" && postureName(degrees: 94.6) == "book" && postureName(degrees: 180) == "open", "postures")
// The screen event line (the contract): one line, the drawn pixels, the words; nothing outside the bounds.
let bookLine = screenEventLine(id: 3, role: "inner", geometry: ScreenGeometry(native: CGSize(width: 2007, height: 2853), scale: 3, rotation: 90), posture: "book")
check(bookLine == "@nomac {\"screen\":{\"id\":3,\"role\":\"inner\",\"width\":2853,\"height\":2007,\"scale\":3,\"orientation\":\"landscape\"},\"posture\":\"book\"}\n", "book line \(bookLine ?? "nil")")
if let line = bookLine, let json = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(7).utf8)) as? [String: Any] {
  check((json["screen"] as? [String: Any])?["width"] as? Int == 2853 && json["posture"] as? String == "book", "the line is JSON")
} else { check(false, "the line parses") }
check(screenEventLine(id: 1, role: "main", geometry: ScreenGeometry(native: CGSize(width: 1206, height: 2622), scale: 3, rotation: 0), posture: nil)?.hasSuffix("\"orientation\":\"portrait\"}}\n") == true, "a phone's line has no posture")
check(screenEventLine(id: 1, role: "outer", geometry: ScreenGeometry(native: CGSize(width: 9000, height: 2034), scale: 3, rotation: 0), posture: "closed") == nil, "a side past 8192 is never told")
check(screenEventLine(id: 1, role: "outer", geometry: ScreenGeometry(native: CGSize(width: 1398, height: 2034), scale: 5, rotation: 0), posture: "closed") == nil, "a scale past 4 is never told")
check(screenEventLine(id: 1, role: "side", geometry: ScreenGeometry(native: CGSize(width: 1398, height: 2034), scale: 3, rotation: 0), posture: "closed") == nil, "an unknown role is never told")
check(screenEventLine(id: 1, role: "outer", geometry: ScreenGeometry(native: CGSize(width: 1398, height: 2034), scale: 3, rotation: 0), posture: "flat") == nil, "an unknown posture is never told")
check(screenEventLine(id: 1, role: "outer", geometry: ScreenGeometry(native: CGSize(width: 1398, height: 2034), scale: 3, rotation: 0), posture: "closed")!.utf8.count < 512, "a line fits one atomic pipe write")
// Stills: the counter moves with any change of what the picture depends on, and only then.
var tracker = StillTracker()
let key = StillKey(screen: 1, rotation: 0, surface: 7, seed: 100)
let first = tracker.counter(for: key)
check(tracker.counter(for: key) == first, "the same picture keeps its counter")
check(tracker.counter(for: StillKey(screen: 1, rotation: 0, surface: 7, seed: 101)) == first + 1, "a write moves it")
check(tracker.counter(for: StillKey(screen: 3, rotation: 90, surface: 9, seed: 101)) == first + 2, "another screen moves it")
check(tracker.counter(for: StillKey(screen: 3, rotation: 0, surface: 9, seed: 101)) == first + 3, "a turn moves it")
check(tracker.counter(for: StillKey(screen: 3, rotation: 0, surface: 10, seed: 101)) == first + 4, "a new buffer moves it")
check(stillScale(nil) == 0.5 && stillScale(7) == 1 && stillScale(0) == 0.05, "scale bounds")
check(stillQuality(nil) == 0.6 && stillQuality(-1) == 0.1, "quality bounds")
check(stillQualities(from: 0.6) == [0.6, 0.3, 0.15, 0.1], "qualities halve to 0.1: \(stillQualities(from: 0.6))")
check(stillQualities(from: 0.1) == [0.1], "the lowest quality alone")
check(qosNamed("utility") == QOS_CLASS_UTILITY.rawValue && qosNamed("background") == QOS_CLASS_BACKGROUND.rawValue && qosNamed("fast") == nil, "QoS names")
print(failures == 0 ? "geometry: all checks passed" : "geometry: \(failures) failed")
exit(failures == 0 ? 0 : 1)
