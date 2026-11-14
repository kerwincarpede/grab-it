// Usage: presented <seconds> [binary to run with --open region at 1 s] [pid: only that app's "Grab-it capture" window]
// Counts frames with new content that reach the display (ScreenCaptureKit
// delivers .complete only when something changed), in 250 ms buckets.
import Foundation
import ScreenCaptureKit
import CoreMedia

let args = Array(CommandLine.arguments.dropFirst())
let seconds = Double(args.first ?? "9") ?? 9
/// Optional: a binary to run with `--open region` one second in.
let trigger = args.count > 1 ? args[1] : nil
var triggeredAt: Double? = nil
final class Out: NSObject, SCStreamOutput {
  var times: [Double] = []
  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    times.append(CMSampleBufferGetPresentationTimeStamp(sb).seconds)
  }
}
let out = Out()
let sem = DispatchSemaphore(value: 0)
Task {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  let display = content.displays[0]
  var filter = SCContentFilter(display: display, excludingWindows: [])
  if args.count > 2, let pid = Int32(args[2]) {
    // Only the overlay window: changes under a see-through window would count too.
    let all = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let win = all.windows.first(where: { $0.owningApplication?.processID == pid && $0.title == "Grab-it capture" }) else {
      print("no overlay window for pid", pid); exit(1)
    }
    filter = SCContentFilter(desktopIndependentWindow: win)
  }
  let cfg = SCStreamConfiguration()
  cfg.width = display.width / 2; cfg.height = display.height / 2
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: 240)
  cfg.queueDepth = 8
  cfg.showsCursor = false
  let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
  try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
  try await stream.startCapture()
  FileHandle.standardError.write("capturing\n".data(using: .utf8)!)
  if let trigger {
    try await Task.sleep(nanoseconds: 1_000_000_000)
    let p = Process(); p.executableURL = URL(fileURLWithPath: trigger); p.arguments = ["--open", "region"]
    triggeredAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    try p.run()
    try await Task.sleep(nanoseconds: UInt64((seconds - 1) * 1e9))
  } else {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
  }
  try? await stream.stopCapture()
  sem.signal()
}
// The window may be gone (Esc destroys it), so never wait forever.
_ = sem.wait(timeout: .now() + seconds + 3)
let t = out.times
guard let t0 = t.first else { print("no frames"); exit(0) }
var buckets = [Int](repeating: 0, count: Int(seconds * 4) + 1)
for x in t { let b = Int((x - t0) * 4); if b < buckets.count { buckets[b] += 1 } }
print("fps per 250ms bucket:", buckets.map { $0 * 4 }.map(String.init).joined(separator: " "))
if let at = triggeredAt {
  let after = t.filter { $0 > at }
  if let first = after.first { print("first changed frame", Int((first - at) * 1000), "ms after trigger") }
}
let gaps = zip(t.dropFirst(), t).map { ($0 - $1) * 1000 }.filter { $0 < 100 }.sorted()
if !gaps.isEmpty { print("gap p50", gaps[gaps.count/2], "p95", gaps[Int(Double(gaps.count)*0.95)]) }
