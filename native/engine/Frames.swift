// Where the screen changed, not only that it did: a copy of the Simulator's screen buffer (an IOSurface), compared
// with the buffer now, row by row. The surface's seed says for free that something was written; this says what.
import Foundation
import CoreGraphics
import IOSurface

/** A rectangle in screen points, as the engine's answers carry it: [x, y, width, height]. */
func rectArray(_ r: CGRect) -> [Double] { [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)].map { ($0 * 10).rounded() / 10 } }

final class PixelReference {
  private var buffer: UnsafeMutableRawPointer?
  private var size = 0
  private(set) var width = 0, height = 0, bytesPerRow = 0, bytesPerElement = 4
  /** The surface's seed when the copy was made. */
  private(set) var seed: UInt32 = 0
  var valid: Bool { buffer != nil }
  deinit { buffer?.deallocate() }

  /** Copies the surface as it is now; false when it can't be read. */
  @discardableResult
  func capture(_ surface: IOSurface) -> Bool {
    let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
    var lockSeed: UInt32 = 0
    guard IOSurfaceLock(ref, .readOnly, &lockSeed) == KERN_SUCCESS else { return false }
    defer { IOSurfaceUnlock(ref, .readOnly, &lockSeed) }
    let bpr = IOSurfaceGetBytesPerRow(ref), h = IOSurfaceGetHeight(ref), n = bpr * h
    guard n > 0 else { return false }
    if n != size { buffer?.deallocate(); buffer = UnsafeMutableRawPointer.allocate(byteCount: n, alignment: 64); size = n }
    memcpy(buffer!, IOSurfaceGetBaseAddress(ref), n)
    width = IOSurfaceGetWidth(ref); height = h; bytesPerRow = bpr; bytesPerElement = max(1, IOSurfaceGetBytesPerElement(ref))
    // The seed as the lock found it, before the copy: a write that lands during the copy moves the seed past it, so
    // the next look compares again instead of taking the copy as current.
    seed = lockSeed
    return true
  }

  /**
   * The box, in pixels, around everything that differs between the copy and the surface now (nil: nothing does).
   * readable is false when the surface could not be read or changed size (then treat the whole screen as changed).
   * With update, the copy takes the surface's changed rows, so the next call compares with now.
   */
  func diff(_ surface: IOSurface, update: Bool) -> (readable: Bool, box: CGRect?) {
    let (readable, box, _, _) = diffBands(surface, update: update)
    return (readable, box)
  }

  /** Rows that did not change between two runs of changed rows, up to this many, do not part them into two bands. */
  static let bandGap = 12
  /** More bands than this are one change of the screen: the box alone. */
  static let maxBands = 12

  /**
   * As diff, and the changed rows as bands: each run of changed rows (runs up to bandGap unchanged rows apart are
   * one) with the columns that changed in it. Two bars changing at the top and the bottom of the screen are one box
   * as tall as the screen, and two bands that say how little of it changed. changed is how many pixels the changed
   * rows span, each from its first changed pixel to its last: a scroll indicator fading down the screen's edge makes
   * a band as tall as the screen that is a few pixels of each row.
   */
  func diffBands(_ surface: IOSurface, update: Bool) -> (readable: Bool, box: CGRect?, bands: [CGRect], changed: Int) {
    guard let buffer else { return (false, nil, [], 0) }
    let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
    var lockSeed: UInt32 = 0
    guard IOSurfaceLock(ref, .readOnly, &lockSeed) == KERN_SUCCESS else { return (false, nil, [], 0) }
    defer { IOSurfaceUnlock(ref, .readOnly, &lockSeed) }
    guard IOSurfaceGetBytesPerRow(ref) == bytesPerRow, IOSurfaceGetHeight(ref) == height, IOSurfaceGetWidth(ref) == width else { return (false, nil, [], 0) }
    let base = IOSurfaceGetBaseAddress(ref)
    let rowBytes = width * bytesPerElement
    var top = -1, bottom = -1, left = Int.max, right = -1
    var bands: [CGRect] = []
    var changed = 0
    // The band being gathered: its first and last changed rows and its columns.
    var bandTop = -1, bandBottom = -1, bandLeft = Int.max, bandRight = -1
    func closeBand() {
      if bandTop >= 0 { bands.append(CGRect(x: bandLeft, y: bandTop, width: bandRight - bandLeft + 1, height: bandBottom - bandTop + 1)) }
      bandTop = -1; bandLeft = Int.max; bandRight = -1
    }
    for y in 0..<height {
      let a = buffer + y * bytesPerRow, b = base + y * bytesPerRow
      if memcmp(a, b, rowBytes) == 0 { continue }
      if top < 0 { top = y }
      bottom = y
      // The changed columns of this row: from each end to the first byte that differs.
      var l = 0
      while l < rowBytes && a.load(fromByteOffset: l, as: UInt8.self) == b.load(fromByteOffset: l, as: UInt8.self) { l += 1 }
      var r = rowBytes - 1
      while r > l && a.load(fromByteOffset: r, as: UInt8.self) == b.load(fromByteOffset: r, as: UInt8.self) { r -= 1 }
      let rowLeft = l / bytesPerElement, rowRight = r / bytesPerElement
      left = min(left, rowLeft); right = max(right, rowRight)
      changed += rowRight - rowLeft + 1
      if bandTop >= 0 && y - bandBottom > Self.bandGap { closeBand() }
      if bandTop < 0 { bandTop = y }
      bandBottom = y; bandLeft = min(bandLeft, rowLeft); bandRight = max(bandRight, rowRight)
      if update { memcpy(a, b, rowBytes) }
    }
    closeBand()
    if update { seed = lockSeed }
    guard top >= 0 else { return (true, nil, [], 0) }
    let box = CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
    return (true, box, bands.count > Self.maxBands ? [box] : bands, changed)
  }
}
