import CoreMedia
import CoreVideo
import VideoToolbox
import Foundation

struct CaptureConfiguration: Decodable {
    let width: Int
    let height: Int
    let framerate: Int
    let bitrate: Int
    let codec: String
    enum CodingKeys: String, CodingKey {
        case width, height, bitrate, codec
        case framerate = "fps"
    }
}

struct EncodedVideo {
    let data: Data
    let width: Int32
    let height: Int32
    let profile: String
    let pts: Int64
    let duration: Int64
    let key: Bool
}

// One in-flight buffer bounds capture input. The Go bridge copies each access unit
// before returning, so output backpressure never creates an unbounded Swift queue.
final class VideoEncoder {
    private final class Output {
        private let lock = NSLock()
        private var busy = false
        private var alive = true
        private let receive: (CMSampleBuffer) -> Void
        private let fail: (Error) -> Void
        private let ready: () -> Void
        init(receive: @escaping (CMSampleBuffer) -> Void, ready: @escaping () -> Void, fail: @escaping (Error) -> Void) {
            self.receive = receive; self.ready = ready; self.fail = fail
        }
        func acquire() -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard alive, !busy else { return false }
            busy = true; return true
        }
        func complete(_ status: OSStatus, sample: CMSampleBuffer?) {
            lock.lock()
            let current = alive
            lock.unlock()
            if current {
                if status != noErr { fail(EncoderError(stage: "output", status: status)) }
                else if let sample, CMSampleBufferDataIsReady(sample) { receive(sample) }
            }
            lock.lock(); busy = false; lock.unlock()
            if current { ready() }
        }
        func retire() { lock.lock(); alive = false; lock.unlock() }
    }
    struct EncoderError: LocalizedError {
        let stage: String
        let status: OSStatus
        var errorDescription: String? { "VideoToolbox \(stage) failed (\(status))." }
    }
    private let configuration: CaptureConfiguration
    private let receive: (EncodedVideo) -> Void
    private let fail: (Error) -> Void
    private let ready: () -> Void
    private var output: Output?
    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var sourceWidth = 0, sourceHeight = 0
    private var lastBucket: Int64?
    private var keyFrame = true
    private var active = true
    private var bitrate: Int

    init(configuration: CaptureConfiguration, receive: @escaping (EncodedVideo) -> Void,
         ready: @escaping () -> Void,
         fail: @escaping (Error) -> Void) {
        self.configuration = configuration; self.bitrate = configuration.bitrate
        self.receive = receive; self.ready = ready; self.fail = fail
    }
    // A recovery frame must reach Go before its output plan can reactivate us.
    func requestKeyFrame() { keyFrame = true; active = true }
    func setActive(_ value: Bool) -> Bool {
        guard active != value else { return false }
        active = value; if value { keyFrame = true }
        return true
    }
    func setBitrate(_ value: Int) throws {
        bitrate = value
        if let session { try require(VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                                                         value: NSNumber(value: value)), "bitrate") }
    }
    func encode(_ image: CVPixelBuffer, at time: CMTime) throws -> Bool {
        guard active, time.isNumeric else { return false }
        let bucket = CMTimeConvertScale(time, timescale: Int32(configuration.framerate), method: .roundTowardZero).value
        if bucket == lastBucket && !keyFrame { return false }
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        if session == nil || sourceWidth != width || sourceHeight != height {
            close(); try prepare(width: width, height: height)
        }
        guard let session, let transfer, let pool = VTCompressionSessionGetPixelBufferPool(session),
              let output, output.acquire() else { return false }
        do {
            var scaled: CVPixelBuffer?
            try require(CVPixelBufferPoolCreatePixelBuffer(nil, pool, &scaled), "allocate")
            guard let scaled else { throw EncoderError(stage: "pixel buffer", status: kCVReturnError) }
            try require(VTPixelTransferSessionTransferImage(transfer, from: image, to: scaled), "scale")
            let properties: CFDictionary? = keyFrame
                ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
            let status = VTCompressionSessionEncodeFrame(session, imageBuffer: scaled,
                presentationTimeStamp: time, duration: CMTime(value: 1, timescale: Int32(configuration.framerate)),
                frameProperties: properties, infoFlagsOut: nil) { status, _, sample in
                    output.complete(status, sample: sample)
                }
            try require(status, "encode")
            keyFrame = false; lastBucket = bucket
            return true
        } catch { output.complete(noErr, sample: nil); throw error }
    }
    private func prepare(width: Int, height: Int) throws {
        guard width > 0, height > 0 else { throw EncoderError(stage: "dimensions", status: -1) }
        let scale = min(1, min(Double(configuration.width) / Double(width), Double(configuration.height) / Double(height)))
        let w = max(2, Int(Double(width) * scale) & ~1), h = max(2, Int(Double(height) * scale) & ~1)
        let attributes: [String: Any] = [
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        do {
            try require(VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h),
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary,
                imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &session), "create")
            guard let session else { throw EncoderError(stage: "session", status: -1) }
            for (key, value) in [
                (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef),
                (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef),
                (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel as CFTypeRef),
                (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
                (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: configuration.framerate)),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: configuration.framerate * 2))
            ] { try require(VTSessionSetProperty(session, key: key, value: value), "property") }
            try require(VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer), "scaler")
            try require(VTCompressionSessionPrepareToEncodeFrames(session), "prepare")
            output = Output(receive: { [receive, fail, configuration] sample in
                do { receive(try Self.accessUnit(sample, duration: 1_000_000 / Int64(configuration.framerate))) }
                catch { fail(error) }
            }, ready: ready, fail: fail)
            sourceWidth = width; sourceHeight = height; keyFrame = true
        } catch { close(); throw error }
    }
    private static func accessUnit(_ sample: CMSampleBuffer, duration: Int64) throws -> EncodedVideo {
        guard let format = CMSampleBufferGetFormatDescription(sample), let buffer = CMSampleBufferGetDataBuffer(sample)
        else { throw EncoderError(stage: "sample", status: -1) }
        var sps: UnsafePointer<UInt8>?, count = 0, parameterCount = 0, headerLength: Int32 = 0
        try require(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0,
            parameterSetPointerOut: &sps, parameterSetSizeOut: &count, parameterSetCountOut: &parameterCount,
            nalUnitHeaderLengthOut: &headerLength), "SPS")
        guard let sps, count >= 4, headerLength == 4 else { throw EncoderError(stage: "AVC format", status: -1) }
        let profile = String(format: "%02x%02x%02x", sps[1], sps[2], sps[3])
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool ?? false)
        var result = Data()
        if key {
            for index in 0..<parameterCount {
                var pointer: UnsafePointer<UInt8>?, length = 0
                try require(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                    parameterSetPointerOut: &pointer, parameterSetSizeOut: &length, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil), "parameter set")
                guard let pointer else { throw EncoderError(stage: "parameter set", status: -1) }
                result.append(contentsOf: [0, 0, 0, 1]); result.append(pointer, count: length)
            }
        }
        let length = CMBlockBufferGetDataLength(buffer)
        guard length > 0 else { throw EncoderError(stage: "empty access unit", status: -1) }
        var avc = Data(count: length)
        let status = avc.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(buffer, atOffset: 0, dataLength: length,
                                                                          destination: $0.baseAddress!) }
        try require(status, "access unit")
        var offset = 0
        while offset + 4 <= avc.count {
            let size = avc[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            guard size > 0, size <= avc.count - offset else { throw EncoderError(stage: "NAL length", status: -1) }
            result.append(contentsOf: [0, 0, 0, 1]); result.append(avc[offset..<offset + size]); offset += size
        }
        guard offset == avc.count, !result.isEmpty else { throw EncoderError(stage: "NAL payload", status: -1) }
        let dimensions = CMVideoFormatDescriptionGetDimensions(format)
        let pts = CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), timescale: 1_000_000,
                                     method: .roundTowardZero).value
        return EncodedVideo(data: result, width: dimensions.width, height: dimensions.height, profile: profile,
                            pts: pts, duration: duration, key: key)
    }
    func close() {
        output?.retire(); output = nil
        if let session { VTCompressionSessionInvalidate(session) }
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        session = nil; transfer = nil; lastBucket = nil
    }
    private static func require(_ status: OSStatus, _ stage: String) throws {
        if status != noErr { throw EncoderError(stage: stage, status: status) }
    }
    private func require(_ status: OSStatus, _ stage: String) throws { try Self.require(status, stage) }
    deinit { close() }
}
