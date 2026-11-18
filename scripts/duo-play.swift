// Whether a video plays, as AVFoundation (QuickTime, Safari) opens it: its length, its picture's size, and 20 frames
// decoded across it, with how bright each is (a black frame reads near 0).
//   xcrun swift scripts/duo-play.swift FILE.mp4   prints one JSON line
import AVFoundation
import CoreGraphics
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
var out: [String: Any] = ["file": url.path]
let done = DispatchSemaphore(value: 0)
func brightness(_ image: CGImage) -> Double {
  let w = 32, h = 32
  var pixels = [UInt8](repeating: 0, count: w * h * 4)
  guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return -1 }
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  var sum = 0
  for i in stride(from: 0, to: pixels.count, by: 4) { sum += Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) }
  return Double(sum) / Double(w * h * 3)
}
Task {
  do {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration)
    out["playable"] = try await asset.load(.isPlayable)
    out["seconds"] = duration.seconds
    let tracks = try await asset.loadTracks(withMediaType: .video)
    out["video_tracks"] = tracks.count
    if let track = tracks.first {
      let size = try await track.load(.naturalSize)
      out["width"] = Int(size.width); out["height"] = Int(size.height)
      out["frames_per_second"] = Double(try await track.load(.nominalFrameRate))
    }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
    var frames: [[String: Any]] = []
    // 20 frames spread over the whole video (its first and last among them).
    let count = 20
    for at in (0..<count).map({ i in max(0, min(duration.seconds - 0.3, 0.2 + (duration.seconds - 0.5) * Double(i) / Double(count - 1))) }) {
      let (image, actual) = try await generator.image(at: CMTime(seconds: at, preferredTimescale: 600))
      frames.append(["at": actual.seconds, "width": image.width, "height": image.height, "brightness": brightness(image)])
    }
    out["frames"] = frames
  } catch {
    out["error"] = "\(error)"
  }
  done.signal()
}
done.wait()
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
