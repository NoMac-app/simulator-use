// The geometry of a screen the guest draws turned (an iPhone Duo's inner screen, half open), kept apart from the
// engine's frameworks so its tests build with any Swift (native/engine/test/geometry-test.swift).
//
// A screen's buffer (an IOSurface) is always the panel's own pixels, unturned. The guest draws its interface in one
// of four turns of it (the panel's currentOrientation: rot0, rot90, rot180, rot270), and accessibility, taps and the
// agent's points are in that drawn interface: "logical" points, top left origin. The turns are AXe 2.0's
// (FBSimulatorHIDDisplayContext.normalizedPoint, MIT), checked there against the guest's own readback on a Duo.
import Foundation
import CoreGraphics

struct ScreenGeometry: Equatable {
  /** The panel's own pixels, unturned (its buffer's size). */
  var native: CGSize
  /** Pixels per point. */
  var scale: CGFloat
  /** The guest's turn of the interface: 0, 90, 180 or 270. */
  var rotation: Int

  var turned: Bool { rotation % 180 != 0 }
  /** The picture as drawn, in pixels: the panel's pixels, turned. */
  var drawnPixels: CGSize { turned ? CGSize(width: native.height, height: native.width) : native }
  /** The screen in the interface's points. */
  var points: CGSize { CGSize(width: drawnPixels.width / scale, height: drawnPixels.height / scale) }
  /** portrait or landscape, as drawn. */
  var orientation: String { drawnPixels.width > drawnPixels.height ? "landscape" : "portrait" }

  /**
   * A point of the drawn interface (points, top left) as a fraction of the panel's own width and height: what a
   * screen-targeted touch takes. AXe's mapping, outside the screen clamped to its edge.
   */
  func normalized(_ p: CGPoint) -> CGPoint {
    let w = native.width / scale, h = native.height / scale
    let size = points
    let x = min(max(p.x, 0), size.width), y = min(max(p.y, 0), size.height)
    switch rotation {
    case 90: return CGPoint(x: y / w, y: 1 - x / h)
    case 180: return CGPoint(x: 1 - x / w, y: 1 - y / h)
    case 270: return CGPoint(x: 1 - y / w, y: x / h)
    default: return CGPoint(x: x / w, y: y / h)
    }
  }

  /** A point of the panel's own pixels (unturned, top left) in the drawn interface's points. */
  func logical(nativePixel u: CGFloat, _ v: CGFloat) -> CGPoint {
    let W = native.width, H = native.height
    let p: CGPoint
    switch rotation {
    case 90: p = CGPoint(x: H - v, y: u)
    case 180: p = CGPoint(x: W - u, y: H - v)
    case 270: p = CGPoint(x: v, y: W - u)
    default: p = CGPoint(x: u, y: v)
    }
    return CGPoint(x: p.x / scale, y: p.y / scale)
  }

  /** A box of the panel's own pixels (a changed area of its buffer) in the drawn interface's points. */
  func logicalRect(nativePixels box: CGRect) -> CGRect {
    let a = logical(nativePixel: box.minX, box.minY), b = logical(nativePixel: box.maxX, box.maxY)
    return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
  }

  /** A point of the drawn interface (points) on the panel's own, unturned points (what a point read by display takes). */
  func nativePoint(_ p: CGPoint) -> CGPoint {
    let n = normalized(p)
    return CGPoint(x: n.x * native.width / scale, y: n.y * native.height / scale)
  }

  /**
   * The affine transform that turns the panel's own picture into the picture as drawn, in Core Image's coordinates
   * (origin bottom left, pixels): applied to the buffer's image it gives the drawn picture, at the origin.
   */
  var drawnTransform: CGAffineTransform {
    let W = native.width, H = native.height
    switch rotation {
    case 90: return CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: W)
    case 180: return CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: W, ty: H)
    case 270: return CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: H, ty: 0)
    default: return .identity
    }
  }
}

/**
 * The canvas a recording across folds is drawn on: as wide as the widest picture any screen can show and as tall as
 * the tallest (each screen in either orientation when the guest can turn it), so one encoder, never restarted, holds
 * every screen; each picture drawn in its middle at the recording's scale. Sides are even (H.264 wants them so).
 */
func recordingCanvas(_ screens: [ScreenGeometry], scale: CGFloat, turns: Bool) -> CGSize {
  var w: CGFloat = 0, h: CGFloat = 0
  for s in screens {
    for size in turns ? [s.native, CGSize(width: s.native.height, height: s.native.width)] : [s.drawnPixels] {
      w = max(w, size.width); h = max(h, size.height)
    }
  }
  let even = { (v: CGFloat) -> CGFloat in max(2, (v * scale / 2).rounded(.down) * 2) }
  return CGSize(width: even(w), height: even(h))
}

/** Where a picture of size goes on a canvas: scaled by scale, in its middle (whole pixels). */
func centered(_ size: CGSize, on canvas: CGSize, scale: CGFloat) -> CGRect {
  let w = (size.width * scale).rounded(), h = (size.height * scale).rounded()
  return CGRect(x: ((canvas.width - w) / 2).rounded(.down), y: ((canvas.height - h) / 2).rounded(.down), width: w, height: h)
}

/** The posture a hinge angle is: closed below 20 degrees, open above 160, book between (AXe's tabletop: 90). */
func postureName(degrees: Double) -> String { degrees < 20 ? "closed" : degrees > 160 ? "open" : "book" }
/** The angle each posture asks the hinge for (Device Hub's names; AXe's closed, tabletop and open). */
let postureDegrees: [String: Double] = ["closed": 0, "book": 90, "open": 180]

/**
 * The screen event a stream engine writes on stderr when the screen in use or the posture changes (the contract):
 * "@nomac " and {"screen":{id, role, width, height, scale, orientation},"posture":...} on one line, width and height
 * the picture's pixels as drawn. Nil when a value is outside the contract's bounds (sides 32 to 8192 whole pixels,
 * scale 1 to 4, the role and posture words), which no phone has.
 */
func screenEventLine(id: UInt32, role: String, geometry: ScreenGeometry, posture: String?) -> String? {
  let drawn = geometry.drawnPixels, scale = Double(geometry.scale)
  guard (32...8192).contains(Int(drawn.width)), (32...8192).contains(Int(drawn.height)), drawn.width == drawn.width.rounded(), drawn.height == drawn.height.rounded(),
        scale >= 1, scale <= 4, ["main", "outer", "inner"].contains(role) else { return nil }
  let scaleText = scale == scale.rounded() ? String(Int(scale)) : String(scale)
  let screen = "{\"id\":\(id),\"role\":\"\(role)\",\"width\":\(Int(drawn.width)),\"height\":\(Int(drawn.height)),\"scale\":\(scaleText),\"orientation\":\"\(geometry.orientation)\"}"
  if let posture {
    guard ["closed", "book", "open"].contains(posture) else { return nil }
    return "@nomac {\"screen\":\(screen),\"posture\":\"\(posture)\"}\n"
  }
  return "@nomac {\"screen\":\(screen)}\n"
}
