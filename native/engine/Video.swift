// The picture of a chosen screen: screenshots and video of whichever screen of a foldable is in use, made from that
// screen's own buffer (Screens.swift), as AXe 2.0 has no picture but the main screen's. A one-screen phone keeps
// FBSimulatorControl's screenshot and stream (main.swift).
//
// The stream (the live view) follows the screen in use: on a change its encoder is ended and a new one started at the
// new screen's size (a new SPS), and before the new screen's first picture its screen event goes to stderr, one line
// "@nomac {"screen": ..., "posture": ...}" in one write (the contract; hostd reads it there). A recording
// (screen_record, the replay) draws every screen on one canvas that holds any of them, centered, so one encoder runs
// from start to end and the file is one movie.
// The fragmented MP4 is written as FBSimulatorControl writes it (FBVideoStream.m, MIT, Meta), so flattenFmp4 reads it.
import Foundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import ImageIO
import IOSurface
import UniformTypeIdentifiers
import VideoToolbox

// MARK: Screenshots

/** The buffer's pixels as a picture (unturned), wrapped without a copy where its format is plain 8-bit BGRA. */
func surfaceImage(_ surface: IOSurface) -> CGImage? {
  let ref = unsafeBitCast(surface, to: IOSurfaceRef.self)
  var seed: UInt32 = 0
  guard IOSurfaceLock(ref, .readOnly, &seed) == KERN_SUCCESS else { return nil }
  defer { IOSurfaceUnlock(ref, .readOnly, &seed) }
  let w = IOSurfaceGetWidth(ref), h = IOSurfaceGetHeight(ref), bpr = IOSurfaceGetBytesPerRow(ref)
  guard IOSurfaceGetBytesPerElement(ref) == 4, w > 0, h > 0 else { return nil }
  // A copy: the surface keeps changing after the lock is let go.
  let data = Data(bytes: IOSurfaceGetBaseAddress(ref), count: bpr * h)
  guard let provider = CGDataProvider(data: data as CFData) else { return nil }
  let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bpr, space: space,
                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                 provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

/** The screen as drawn (turned as the guest turns it), optionally scaled to size: an opaque image. */
func drawnPicture(_ surface: IOSurface, _ geometry: ScreenGeometry, size: CGSize? = nil) throws -> CGImage {
  guard let image = surfaceImage(surface) else { throw EngineError(message: "the screen buffer can't be read") }
  let drawn = geometry.drawnPixels
  let out = size ?? drawn
  if geometry.rotation == 0 && out == drawn { return image }
  guard let ctx = CGContext(data: nil, width: Int(out.width), height: Int(out.height), bitsPerComponent: 8, bytesPerRow: 0,
                            space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw EngineError(message: "image context unavailable") }
  ctx.interpolationQuality = out == drawn ? .none : .medium
  ctx.scaleBy(x: out.width / drawn.width, y: out.height / drawn.height)
  ctx.concatenate(geometry.drawnTransform)
  ctx.draw(image, in: CGRect(origin: .zero, size: geometry.native))
  guard let made = ctx.makeImage() else { throw EngineError(message: "the screenshot could not be drawn") }
  return made
}

func encodeImage(_ image: CGImage, as type: UTType, quality: Double? = nil) throws -> Data {
  let result = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(result, type.identifier as CFString, 1, nil) else { throw EngineError(message: "\(type) encoder unavailable") }
  CGImageDestinationAddImage(dest, image, quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary })
  guard CGImageDestinationFinalize(dest) else { throw EngineError(message: "\(type) encoding failed") }
  return result as Data
}

// MARK: The encoder

/** A hardware H.264 encoder at one size; its frames come to output in order (no reordering, no delay). */
final class VideoEncoder: @unchecked Sendable {
  let size: CGSize
  private var session: VTCompressionSession?
  private let output: @Sendable (CMSampleBuffer) -> Void

  init(size: CGSize, fps: Double, bitrate: Double, keyframeSeconds: Double, output: @escaping @Sendable (CMSampleBuffer) -> Void) throws {
    self.size = size; self.output = output
    let attributes: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey: Int(size.width),
                                       kCVPixelBufferHeightKey: Int(size.height), kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    var made: VTCompressionSession?
    let status = VTCompressionSessionCreate(allocator: nil, width: Int32(size.width), height: Int32(size.height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true] as CFDictionary,
      imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &made)
    guard status == noErr, let made else { throw EngineError(message: "the video encoder could not start at \(Int(size.width))x\(Int(size.height)) (\(status))") }
    // As FBSimulatorControl's stream: real time, no reordering or delay, High profile with CABAC.
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true, kVTCompressionPropertyKey_AllowFrameReordering: false, kVTCompressionPropertyKey_MaxFrameDelayCount: 0,
      kVTCompressionPropertyKey_AverageBitRate: bitrate, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: keyframeSeconds,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps, kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
      kVTCompressionPropertyKey_H264EntropyMode: kVTH264EntropyMode_CABAC,
    ]
    for (key, value) in properties { VTSessionSetProperty(made, key: key, value: value as CFTypeRef) }
    VTCompressionSessionPrepareToEncodeFrames(made)
    session = made
  }

  /** A buffer to draw the next frame into, from the encoder's own pool. */
  func buffer() -> CVPixelBuffer? {
    guard let session, let pool = VTCompressionSessionGetPixelBufferPool(session) else { return nil }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    return buffer
  }

  func encode(_ buffer: CVPixelBuffer, at seconds: Double, duration: Double, key: Bool) {
    guard let session else { return }
    let pts = CMTime(seconds: seconds, preferredTimescale: 90_000), length = CMTime(seconds: duration, preferredTimescale: 90_000)
    let options = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let deliver = output
    VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: pts, duration: length, frameProperties: options, infoFlagsOut: nil) { status, _, sample in
      if status == noErr, let sample { deliver(sample) }
    }
  }

  /** Every frame given so far comes out, then the encoder ends. */
  func finish() {
    guard let session else { return }
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(session)
    self.session = nil
  }
}

func isKeyFrame(_ sample: CMSampleBuffer) -> Bool {
  guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]], let first = attachments.first else { return true }
  return first[kCMSampleAttachmentKey_NotSync] == nil
}

/** The sample's bytes: H.264 NAL units, each after a 4-byte length (AVCC). */
func sampleBytes(_ sample: CMSampleBuffer) -> Data? {
  guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
  let length = CMBlockBufferGetDataLength(block)
  var data = Data(count: length)
  let status = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
  return status == noErr ? data : nil
}

/** The sequence and picture parameters (SPS, PPS) of the sample's format. */
func parameterSets(_ sample: CMSampleBuffer) -> [Data] {
  guard let format = CMSampleBufferGetFormatDescription(sample) else { return [] }
  var count = 0
  guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr else { return [] }
  return (0..<count).compactMap { i in
    var pointer: UnsafePointer<UInt8>?, size = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer else { return nil }
    return Data(bytes: pointer, count: size)
  }
}

// MARK: Annex B (the live view)

/** A frame as Annex B, as FBSimulatorControl's stream writes it: before a key frame its SPS and PPS, each unit after 00 00 00 01. */
func annexB(_ sample: CMSampleBuffer) -> Data? {
  guard let avcc = sampleBytes(sample) else { return nil }
  let start = Data([0, 0, 0, 1])
  var out = Data(capacity: avcc.count + 64)
  if isKeyFrame(sample) { for set in parameterSets(sample) { out.append(start); out.append(set) } }
  var at = 0
  while at + 4 <= avcc.count {
    let n = Int(avcc[at]) << 24 | Int(avcc[at + 1]) << 16 | Int(avcc[at + 2]) << 8 | Int(avcc[at + 3])
    guard n > 0, at + 4 + n <= avcc.count else { break }
    out.append(start); out.append(avcc.subdata(in: (at + 4)..<(at + 4 + n)))
    at += 4 + n
  }
  return out
}

// MARK: Fragmented MP4 (a recording)

private func be32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.bigEndian) { Data($0) } }
private func be16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.bigEndian) { Data($0) } }
private func be64(_ v: UInt64) -> Data { withUnsafeBytes(of: v.bigEndian) { Data($0) } }
private func box(_ type: String, _ parts: Data...) -> Data {
  let body = parts.reduce(Data(), +)
  return be32(UInt32(8 + body.count)) + Data(type.utf8) + body
}
private func full(_ type: String, _ version: UInt8, _ flags: UInt32, _ parts: Data...) -> Data {
  box(type, be32(UInt32(version) << 24 | (flags & 0xFFFFFF)) + parts.reduce(Data(), +))
}
private let identityMatrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map { be32(UInt32($0)) }.reduce(Data(), +)

/**
 * One video track as fragmented MP4: the movie box once (at the first key frame), then a fragment (moof and mdat)
 * a frame, each written once the next one comes (so its duration is the time to it); the last at finish. The file
 * holds every frame written whenever the recorder ends; flattenFmp4 (src/engine/fmp4.ts) makes it a plain MP4.
 */
final class FragmentedMP4: @unchecked Sendable {
  private let file: FileHandle
  private let lock = NSLock()
  private var started = false
  private var sequence: UInt32 = 0
  private var decodeTime: UInt64 = 0
  private var pending: (data: Data, pts: Double, key: Bool)?
  private(set) var bytes = 0, frames = 0
  static let timescale: Double = 90_000

  init(file: FileHandle) { self.file = file }

  func add(_ sample: CMSampleBuffer) {
    lock.lock(); defer { lock.unlock() }
    let key = isKeyFrame(sample)
    if !started {
      guard key, let format = CMSampleBufferGetFormatDescription(sample), let avcC = avcConfig(format) else { return }
      let dims = CMVideoFormatDescriptionGetDimensions(format)
      write(ftyp() + moov(avcC: avcC, width: UInt32(dims.width), height: UInt32(dims.height)))
      started = true
    }
    guard let data = sampleBytes(sample) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    if let last = pending { fragment(last, duration: max(1, (pts - last.pts) * Self.timescale)) }
    pending = (data, pts, key)
  }

  /** The last frame, given the frame's own duration. */
  func finish(lastDuration: Double) {
    lock.lock(); defer { lock.unlock() }
    if let last = pending { fragment(last, duration: max(1, lastDuration * Self.timescale)) }
    pending = nil
    try? file.synchronize()
  }

  private func write(_ data: Data) { file.write(data); bytes += data.count }

  private func fragment(_ f: (data: Data, pts: Double, key: Bool), duration: Double) {
    sequence += 1; frames += 1
    let d = UInt32(duration.rounded())
    // tfhd: default-base-is-moof; trun: data offset, then the sample's duration, size and flags.
    let trunBody = be32(1) + be32(0) + be32(d) + be32(UInt32(f.data.count)) + be32(f.key ? 0x0200_0000 : 0x0101_0000)
    var moof = box("moof", full("mfhd", 0, 0, be32(sequence)),
                   box("traf", full("tfhd", 0, 0x020000, be32(1)), full("tfdt", 1, 0, be64(decodeTime)), full("trun", 0, 0x000701, trunBody)))
    // The data offset: from the moof's start to the sample's first byte, after the mdat's header.
    let offset = UInt32(moof.count + 8)
    let at = moof.count - trunBody.count + 4
    moof.replaceSubrange(at..<(at + 4), with: be32(offset))
    write(moof + be32(UInt32(8 + f.data.count)) + Data("mdat".utf8) + f.data)
    decodeTime += UInt64(d)
  }

  private func avcConfig(_ format: CMFormatDescription) -> Data? {
    if let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
       let avcC = atoms["avcC"] as? Data { return avcC }
    return nil
  }

  private func ftyp() -> Data { box("ftyp", Data("isom".utf8), be32(0x200), Data("isomiso6mp41".utf8)) }

  private func moov(avcC: Data, width: UInt32, height: UInt32) -> Data {
    let ts = UInt32(Self.timescale)
    let mvhd = full("mvhd", 0, 0, be32(0), be32(0), be32(ts), be32(0), be32(0x0001_0000), be16(0x0100), Data(count: 10), identityMatrix, Data(count: 24), be32(2))
    let tkhd = full("tkhd", 0, 3, be32(0), be32(0), be32(1), be32(0), be32(0), Data(count: 8), be16(0), be16(0), be16(0), be16(0), identityMatrix, be32(width << 16), be32(height << 16))
    let mdhd = full("mdhd", 0, 0, be32(0), be32(0), be32(ts), be32(0), be16(0x55C4), be16(0))
    let hdlr = full("hdlr", 0, 0, be32(0), Data("vide".utf8), Data(count: 12), Data("VideoHandler".utf8) + Data([0]))
    let avc1 = box("avc1", Data(count: 6), be16(1), Data(count: 16), be16(UInt16(width)), be16(UInt16(height)), be32(0x0048_0000), be32(0x0048_0000), be32(0), be16(1),
                   Data(count: 32), be16(0x0018), be16(0xFFFF), box("avcC", avcC))
    let stbl = box("stbl", full("stsd", 0, 0, be32(1), avc1), full("stts", 0, 0, be32(0)), full("stsc", 0, 0, be32(0)), full("stsz", 0, 0, be32(0), be32(0)), full("stco", 0, 0, be32(0)))
    let minf = box("minf", full("vmhd", 0, 1, be16(0), Data(count: 6)), box("dinf", full("dref", 0, 0, be32(1), full("url ", 0, 1))), stbl)
    let trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf))
    let mvex = box("mvex", full("trex", 0, 0, be32(1), be32(1), be32(0), be32(0), be32(0)))
    return box("moov", mvhd, trak, mvex)
  }
}

// MARK: The pump

/**
 * What a screen stream draws next: the slot in use, its geometry and its screen event line (written on the main
 * actor, read by the pump).
 */
final class StreamTarget: @unchecked Sendable {
  private let lock = NSLock()
  private var value: (slot: ScreenSlot, geometry: ScreenGeometry, line: String?)?
  func set(_ slot: ScreenSlot, line: String?) { lock.lock(); value = (slot, slot.geometry, line); lock.unlock() }
  var current: (slot: ScreenSlot, geometry: ScreenGeometry, line: String?)? { lock.lock(); defer { lock.unlock() }; return value }
}

/** One screen event on stderr, whole, in one write (a line this short is never split or interleaved on a pipe). */
func writeEvent(_ line: String) {
  var bytes = Array(line.utf8)
  _ = bytes.withUnsafeMutableBytes { write(2, $0.baseAddress, $0.count) }
}

/**
 * Draws the screen in use into an encoder at a steady rate (as FBSimulatorControl's eager stream does: a frame every
 * tick, the same picture again while nothing changes). follow: the picture is the screen's own, and a new screen
 * restarts the encoder at its size; otherwise (a recording) every screen is drawn on canvas, centered.
 */
final class ScreenStream: @unchecked Sendable {
  let target = StreamTarget()
  private let fps: Double, bitrate: Double, keyframeSeconds: Double, scale: CGFloat
  private let canvas: CGSize?
  private let sink: @Sendable (CMSampleBuffer) -> Void
  /** Called (on the pump's queue) before the first frame after the screen in use or the posture changed, in follow mode. */
  private let announce: @Sendable (String) -> Void
  /** The last screen event told (the ready line's at first): a line is written only when it changes. */
  var told: String?
  private let queue: DispatchQueue
  private var timer: DispatchSourceTimer?
  private var encoder: VideoEncoder?
  private var drawn: (slot: ObjectIdentifier, geometry: ScreenGeometry)?
  private var lastSeed: UInt32 = 0, lastSurface: IOSurface?
  private var lastBuffer: CVPixelBuffer?
  private let started = Date()
  private var lastPTS = -1.0
  private(set) var restarts = 0, framesIn = 0
  private let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
  var failure: String?
  /** Called (on the pump's queue) when the encoder fails: the stream ends with its reason. */
  var onFailure: (() -> Void)?
  /**
   * The hinge's motion: a count of the samples AXe's motion subscription delivered (it moves only while the hinge does),
   * read on each tick, and what to do when it moved (read the hinge, so the posture the stream tells follows it).
   */
  var motionCount: (@Sendable () -> UInt64?)?
  var onMotion: (@Sendable () -> Void)?
  private var lastMotion: UInt64?

  init(qos: DispatchQoS, fps: Double, bitrate: Double, keyframeSeconds: Double, scale: CGFloat, canvas: CGSize?, sink: @escaping @Sendable (CMSampleBuffer) -> Void, announce: @escaping @Sendable (String) -> Void) {
    queue = DispatchQueue(label: "simulator-use-engine stream", qos: qos)
    self.fps = max(1, min(fps, 60)); self.bitrate = bitrate; self.keyframeSeconds = keyframeSeconds; self.scale = scale; self.canvas = canvas
    self.sink = sink; self.announce = announce
  }

  func start() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: 1 / fps, leeway: .milliseconds(2))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume(); timer = t
  }

  /** Ends the pump; every frame encoded comes out first. */
  func stop() {
    queue.sync {
      timer?.cancel(); timer = nil
      encoder?.finish(); encoder = nil
    }
  }

  private func even(_ v: CGFloat) -> CGFloat { max(2, (v / 2).rounded(.down) * 2) }

  private func tick() {
    if let count = motionCount?() {
      if let last = lastMotion, count != last { onMotion?() }
      lastMotion = count
    }
    guard let now = target.current, let surface = now.slot.watcher.currentSurface() else { return }
    let follow = canvas == nil
    let outSize = canvas ?? CGSize(width: even(now.geometry.drawnPixels.width * scale), height: even(now.geometry.drawnPixels.height * scale))
    let id = ObjectIdentifier(now.slot)
    let screenChanged = drawn.map { $0.slot != id || $0.geometry != now.geometry } ?? true
    if encoder == nil || (follow && screenChanged) {
      // A new screen: the old encoder's frames out first, then the new encoder.
      if encoder != nil { encoder?.finish(); restarts += 1 }
      do { encoder = try VideoEncoder(size: outSize, fps: fps, bitrate: bitrate, keyframeSeconds: keyframeSeconds, output: sink) }
      catch { failure = (error as? EngineError)?.message ?? "\(error)"; encoder = nil; timer?.cancel(); onFailure?(); return }
      lastBuffer = nil
    }
    guard let encoder else { return }
    // The screen in use or the posture changed: its event before the first frame drawn of it.
    if follow, let line = now.line, line != told { told = line; announce(line) }
    let seed = surfaceSeed(surface)
    var buffer = lastBuffer
    if buffer == nil || screenChanged || seed != lastSeed || surface !== lastSurface {
      guard let fresh = encoder.buffer() else { return }
      var image = CIImage(ioSurface: surface).transformed(by: now.geometry.drawnTransform)
      if let canvas {
        let place = centered(now.geometry.drawnPixels, on: canvas, scale: scale)
        image = image.transformed(by: CGAffineTransform(scaleX: place.width / now.geometry.drawnPixels.width, y: place.height / now.geometry.drawnPixels.height))
          .transformed(by: CGAffineTransform(translationX: place.minX, y: canvas.height - place.maxY))
        image = image.composited(over: CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: canvas)))
      } else {
        image = image.transformed(by: CGAffineTransform(scaleX: outSize.width / now.geometry.drawnPixels.width, y: outSize.height / now.geometry.drawnPixels.height))
      }
      context.render(image, to: fresh, bounds: CGRect(origin: .zero, size: outSize), colorSpace: nil)
      buffer = fresh; lastBuffer = fresh; lastSeed = seed; lastSurface = surface
    }
    var at = Date().timeIntervalSince(started)
    if at <= lastPTS { at = lastPTS + 0.001 }
    lastPTS = at
    framesIn += 1
    encoder.encode(buffer!, at: at, duration: 1 / fps, key: framesIn == 1 || (follow && screenChanged))
    drawn = (id, now.geometry)
  }
}
