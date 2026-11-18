// Still pictures for a live view that cannot play H.264 (the `still` op): the engine says whether the picture of the
// screen in use changed since the one a viewer has, without capturing anything when it did not, and otherwise sends a
// JPEG of it within a size bound. Kept apart from the engine's frameworks so its test builds with any Swift
// (native/engine/test/geometry/main.swift).
import Foundation

/**
 * What a still depends on: the screen in use, how the guest turns it, its buffer, and the buffer's write seed (which
 * moves on every write). A viewer holds the counter of the still it has; the counter moves whenever any of these did.
 */
struct StillKey: Equatable {
  let screen: UInt32
  let rotation: Int
  let surface: UInt32
  let seed: UInt32
}

/** The engine's still counter: one per engine, moved by the first look at a key that differs from the last. */
struct StillTracker {
  private(set) var counter = 0
  private var last: StillKey?
  /** The counter for the picture as it is now (key read before the capture, so a write during it is never missed). */
  mutating func counter(for key: StillKey) -> Int {
    if last != key { counter += 1; last = key }
    return counter
  }
}

/** The biggest still sent, in bytes: a viewer polling stills never pulls more than this a picture. */
let stillMaxBytes = 600_000
/** A still's scale and JPEG quality as asked, within bounds (defaults 0.5 and 0.6). */
func stillScale(_ asked: Double?) -> Double { min(max(asked ?? 0.5, 0.05), 1) }
func stillQuality(_ asked: Double?) -> Double { min(max(asked ?? 0.6, 0.1), 1) }
/** The qualities tried in turn until a still fits stillMaxBytes: the one asked, then halved, down to 0.1. */
func stillQualities(from start: Double) -> [Double] {
  var out = [start], q = start
  while q > 0.1 { q = max(0.1, q / 2); out.append(q) }
  return out
}

/** The raw value of a QoS class, by the names the engine takes (--qos). */
func qosNamed(_ name: String) -> UInt32? {
  switch name {
  case "user-interactive": return 0x21
  case "user-initiated": return 0x19
  case "default": return 0x15
  case "utility": return 0x11
  case "background": return 0x09
  default: return nil
  }
}
