import Foundation
import CoreMedia
import CoreVideo
import Darwin

struct SmokeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw SmokeFailure(message) }
}

// VT completes on its own callback queue. Wait for production ready(), which
// follows release of the one in-flight slot, rather than racing receive().
final class Observations {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var frames: [EncodedVideo] = []
    private var failure: Error?
    private var droppedRecovery = false

    func receive(_ frame: EncodedVideo) {
        lock.lock(); frames.append(frame); lock.unlock()
    }
    func fail(_ error: Error) {
        lock.lock(); failure = error; lock.unlock()
    }
    func ready(_ retryRecovery: Bool) {
        lock.lock(); droppedRecovery = droppedRecovery || retryRecovery; lock.unlock()
        completed.signal()
    }
    func frame(after count: Int) throws -> EncodedVideo {
        guard completed.wait(timeout: .now() + 5) == .success else {
            throw SmokeFailure("VideoToolbox did not complete an admitted frame within 5 seconds")
        }
        lock.lock(); defer { lock.unlock() }
        if let failure { throw failure }
        try check(!droppedRecovery, "VideoToolbox dropped a forced recovery frame")
        try check(frames.count == count + 1, "admitted input did not produce exactly one access unit")
        return frames[count]
    }
    func count() -> Int {
        lock.lock(); defer { lock.unlock() }
        return frames.count
    }
}

func syntheticImage() throws -> CVPixelBuffer {
    var image: CVPixelBuffer?
    let status = CVPixelBufferCreate(nil, 320, 180,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &image)
    guard status == kCVReturnSuccess, let image else {
        throw SmokeFailure("synthetic CVPixelBuffer allocation failed: \(status)")
    }
    let locked = CVPixelBufferLockBaseAddress(image, [])
    guard locked == kCVReturnSuccess else { throw SmokeFailure("pixel buffer lock failed: \(locked)") }
    defer { CVPixelBufferUnlockBaseAddress(image, []) }
    for plane in 0..<CVPixelBufferGetPlaneCount(image) {
        guard let address = CVPixelBufferGetBaseAddressOfPlane(image, plane) else {
            throw SmokeFailure("synthetic pixel plane is unavailable")
        }
        memset(address, plane == 0 ? 80 : 128,
               CVPixelBufferGetBytesPerRowOfPlane(image, plane) * CVPixelBufferGetHeightOfPlane(image, plane))
    }
    return image
}

func validate(_ frame: EncodedVideo, key: Bool, label: String) throws {
    try check(frame.width == 320 && frame.height == 180, "\(label): wrong encoded dimensions")
    try check(!frame.data.isEmpty && frame.profile.count == 6, "\(label): missing H264 payload/profile")
    let bytes = [UInt8](frame.data)
    var types = Set<UInt8>()
    if bytes.count >= 5 {
        for i in 0...(bytes.count - 5) where bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1 {
            types.insert(bytes[i + 4] & 31)
        }
    }
    try check(types.contains(1) || types.contains(5), "\(label): access unit contains no H264 slice")
    if key {
        try check(frame.key && types.isSuperset(of: [5, 7, 8]), "\(label): forced keyframe lacks IDR/SPS/PPS")
    }
    print("FRAME \(label) bytes=\(frame.data.count) key=\(frame.key) dimensions=\(frame.width)x\(frame.height)")
}

func run() throws {
    let image = try syntheticImage()
    let observed = Observations()
    let encoder = VideoEncoder(configuration: CaptureConfiguration(width: 320, height: 180, framerate: 30,
        bitrate: 500_000, codec: "h264"), receive: observed.receive, ready: observed.ready, fail: observed.fail)
    defer { encoder.close() }
    func submit(_ tick: Int64, key: Bool, label: String) throws {
        let before = observed.count()
        try check(try encoder.encode(image, at: CMTime(value: tick, timescale: 3000)), "\(label): input was not admitted")
        try validate(observed.frame(after: before), key: key, label: label)
    }
    try submit(0, key: true, label: "initial")
    try check(!encoder.setActive(true), "repeated active changed state")
    try check(try !encoder.encode(image, at: CMTime(value: 0, timescale: 3000)), "repeated active forced a same-bucket frame")
    try submit(100, key: false, label: "ordinary")
    try check(try !encoder.encode(image, at: CMTime(value: 100, timescale: 3000)), "ordinary same-bucket frame bypassed rate limit")
    try check(encoder.setActive(false), "pause did not change state")
    try check(!encoder.setActive(false), "repeated pause changed state")
    try check(try !encoder.encode(image, at: CMTime(value: 200, timescale: 3000)), "paused encoder admitted input")
    encoder.requestKeyFrame()
    try submit(101, key: true, label: "paused-keyframe-wakeup")
    try check(!encoder.setActive(true), "keyframe wakeup did not reactivate encoder")
    try check(try !encoder.encode(image, at: CMTime(value: 100, timescale: 3000)), "repeated active reset keyframe/bucket")
    try check(encoder.setActive(false) && encoder.setActive(true), "pause/resume transition failed")
    try submit(102, key: true, label: "resume")
    try submit(200, key: false, label: "ordinary-after-resume")
    try check(observed.count() == 5, "unexpected output count")
    print("PASS production VideoEncoder: H264 output, pause, recovery wakeup, resume, active idempotence, bucket limit")
}

if !VideoEncoder.hardwareAvailable() {
    print("SKIP hardware H264 VideoToolbox encoder unavailable; no output/lifecycle pass claimed")
    exit(77)
}
do { try run() }
catch {
    fputs("FAIL VideoEncoder smoke: \(error)\n", stderr)
    exit(1)
}
