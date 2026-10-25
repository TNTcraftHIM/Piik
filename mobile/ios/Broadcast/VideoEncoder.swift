import CoreMedia
import CoreVideo
import VideoToolbox
import Foundation
import os

// Reuses the desktop producer's VideoToolbox/PCM boundary, not its macOS APIs.
// One in-flight scaled buffer bounds retained ReplayKit input and encoder work.
final class VideoEncoder {
    private final class Output {
        private let lock = NSLock()
        private var busy = false
        private var alive = true
        private var frames = 0
        private var failure: OSStatus = noErr
        private let log = Logger(subsystem: "tv.piik.ios", category: "VideoToolboxProbe")

        func acquire() throws -> Bool {
            lock.lock(); defer { lock.unlock() }
            if failure != noErr { throw EncoderError(stage: "output", status: failure) }
            guard alive, !busy else { return false }
            busy = true
            return true
        }

        func complete(_ status: OSStatus, sample: CMSampleBuffer?) {
            lock.lock(); defer { lock.unlock() }
            busy = false
            guard alive else { return }
            if status != noErr { failure = status; return }
            guard let sample, CMSampleBufferDataIsReady(sample) else { return }
            frames += 1
            if frames == 1 { log.info("First actual H264 sample encoded") }
        }

        func retire() { lock.lock(); alive = false; lock.unlock() }
    }

    struct EncoderError: LocalizedError {
        let stage: String
        let status: OSStatus
        var errorDescription: String? { "VideoToolbox \(stage) failed (\(status))." }
    }

    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var sourceWidth = 0, sourceHeight = 0
    private var lastTime = CMTime.invalid
    private var lastBucket: Int64?
    private var output = Output()

    func encode(_ image: CVPixelBuffer, at time: CMTime) throws {
        guard time.isNumeric, !lastTime.isValid || CMTimeCompare(time, lastTime) > 0 else { return }
        let bucket = CMTimeConvertScale(time, timescale: 30, method: .roundTowardZero).value
        if bucket == lastBucket { return }
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        if session == nil || sourceWidth != width || sourceHeight != height {
            close()
            try prepare(width: width, height: height)
        }
        guard let session, let transfer, let pool = VTCompressionSessionGetPixelBufferPool(session),
              try output.acquire() else { return }
        do {
            var scaled: CVPixelBuffer?
            try require(CVPixelBufferPoolCreatePixelBuffer(nil, pool, &scaled), "allocate")
            guard let scaled else { throw EncoderError(stage: "pixel buffer", status: kCVReturnError) }
            try require(VTPixelTransferSessionTransferImage(transfer, from: image, to: scaled), "scale")
            let currentOutput = output
            let status = VTCompressionSessionEncodeFrame(session, imageBuffer: scaled,
                presentationTimeStamp: time, duration: .invalid, frameProperties: nil,
                infoFlagsOut: nil) { status, _, sample in currentOutput.complete(status, sample: sample) }
            try require(status, "encode")
            lastTime = time
            lastBucket = bucket
        } catch {
            output.complete(noErr, sample: nil)
            throw error
        }
    }

    private func prepare(width: Int, height: Int) throws {
        guard width > 0, height > 0 else { throw EncoderError(stage: "dimensions", status: -1) }
        let scale = min(1, min(720.0 / Double(min(width, height)), 1280.0 / Double(max(width, height))))
        let w = max(2, Int(Double(width) * scale) & ~1)
        let h = max(2, Int(Double(height) * scale) & ~1)
        let attributes: [String: Any] = [
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        do {
            var specification: [String: Any] = [:]
            if #available(iOS 17.4, *) {
                specification[kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String] = true
            }
            try require(VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h),
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: specification as CFDictionary,
                imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &session), "create")
            guard let session else { throw EncoderError(stage: "session", status: -1) }
            let properties: [(CFString, CFTypeRef)] = [
                (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
                (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
                (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel),
                (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: 3_000_000)),
                (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: 30)),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 60))
            ]
            for (key, value) in properties { try require(VTSessionSetProperty(session, key: key, value: value), "property") }
            try require(VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer), "scaler")
            guard let transfer else { throw EncoderError(stage: "scaler", status: -1) }
            try require(VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_ScalingMode,
                value: kVTScalingMode_Letterbox), "scale mode")
            try require(VTCompressionSessionPrepareToEncodeFrames(session), "prepare")
            sourceWidth = width; sourceHeight = height
        } catch { close(); throw error }
    }

    func close() {
        output.retire()
        if let session { VTCompressionSessionInvalidate(session) }
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        session = nil; transfer = nil
        output = Output()
        lastTime = .invalid
        lastBucket = nil
    }

    private func require(_ status: OSStatus, _ stage: String) throws {
        if status != noErr { throw EncoderError(stage: stage, status: status) }
    }
    deinit { close() }
}
