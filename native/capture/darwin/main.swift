import AVFoundation
import AudioToolbox
import CoreAudio
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

private let captureProtocol = 7
private let maxOutputs = 6
private let width = 1280
private let height = 720
private let frameRate: Int32 = 30
private let bitrate = 3_000_000
private let maxPayloadBytes = 4_194_304
private let maxVideoDimension = 8192
private let maxVideoPixels = 36_864 * 16 * 16
private let maxVideoFramerate: Int32 = 240
private let maxVideoBitrate = 240_000_000
private let maxCodedVideoDimension = 8192
private let maxCodedVideoPixels = 36_864 * 16 * 16
private let supportedH264Levels: Set<UInt8> = [
    0x0a, 0x0b, 0x0c, 0x0d, 0x14, 0x15, 0x16,
    0x1e, 0x1f, 0x20, 0x28, 0x29, 0x2a, 0x32, 0x33, 0x34,
]

private enum DegradationPreference: String {
    case resolution = "maintain-resolution"
    case balanced
    case framerate = "maintain-framerate"
}

private struct VideoProfile {
    let width: Int
    let height: Int
    let frameRate: Int32
    let bitrate: Int
    let preference: DegradationPreference

    var frameInterval: CMTime { CMTime(value: 1, timescale: frameRate) }
    var timestampStep: CMTime { CMTime(value: 1, timescale: 90_000) }
}

private struct OutputProfile: Codable {
    let width: Int
    let height: Int
    let fps: Int32
    let bitrate: Int

    var frameInterval: CMTime { CMTime(value: 1, timescale: fps) }
}

// Keep the captured pixels, their clean aperture and their unscaled size together.
// ScreenCaptureKit may place scaled window content inside a larger fixed surface.
private struct VideoImage {
    let buffer: CVPixelBuffer
    let size: CGSize

    init(_ buffer: CVPixelBuffer) {
        self.buffer = buffer
        self.size = CVImageBufferGetCleanRect(buffer).size
    }

    init?(_ buffer: CVPixelBuffer, attachments: [SCStreamFrameInfo: Any]) {
        guard let dictionary = attachments[.contentRect] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              let scale = attachments[.scaleFactor] as? CGFloat,
              let contentScale = attachments[.contentScale] as? CGFloat,
              scale.isFinite, scale > 0, contentScale.isFinite, contentScale > 0 else {
            return nil
        }
        let reportedCrop = CGRect(x: rect.minX * scale, y: rect.minY * scale,
                                  width: rect.width * scale, height: rect.height * scale)
        let bounds = CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer),
                            height: CVPixelBufferGetHeight(buffer))
        // Scaling metadata can cross a pixel edge fractionally. Keep the clean
        // aperture inside the surface while rejecting more than half a pixel.
        guard reportedCrop.minX.isFinite, reportedCrop.minY.isFinite,
              reportedCrop.width.isFinite, reportedCrop.height.isFinite,
              reportedCrop.width > 0, reportedCrop.height > 0,
              bounds.insetBy(dx: -0.5, dy: -0.5).contains(reportedCrop) else { return nil }
        let crop = reportedCrop.intersection(bounds)
        guard !crop.isEmpty else { return nil }
        let size = CGSize(width: crop.width / contentScale, height: crop.height / contentScale)
        guard size.width.isFinite, size.height.isFinite else { return nil }
        // Set once before sharing the retained buffer with the output workers.
        let aperture: [String: Any] = [
            kCVImageBufferCleanApertureWidthKey as String: crop.width,
            kCVImageBufferCleanApertureHeightKey as String: crop.height,
            kCVImageBufferCleanApertureHorizontalOffsetKey as String: crop.midX - bounds.midX,
            kCVImageBufferCleanApertureVerticalOffsetKey as String: crop.midY - bounds.midY,
        ]
        CVBufferSetAttachment(buffer, kCVImageBufferCleanApertureKey,
                              aperture as CFDictionary, .shouldPropagate)
        self.buffer = buffer
        self.size = size
    }

    func fitted(to profile: OutputProfile) throws -> OutputProfile {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else {
            throw CaptureFailure(description: "invalid video content size")
        }
        let scale = min(1, CGFloat(profile.width) / size.width,
                        CGFloat(profile.height) / size.height)
        return OutputProfile(
            width: max(2, Int((size.width * scale / 2).rounded(.down)) * 2),
            height: max(2, Int((size.height * scale / 2).rounded(.down)) * 2),
            fps: profile.fps, bitrate: profile.bitrate
        )
    }
}

private enum CaptureControl {
    case keyFrame(Int)
    case active(Int, Bool)
    case bitrate(Int, Int)
}

private let defaultVideoProfile = VideoProfile(
    width: width,
    height: height,
    frameRate: frameRate,
    bitrate: bitrate,
    preference: .balanced
)

private struct EncoderProbe: Codable {
    let index: UInt32
    let name: String
    let identity: String
}

private struct AdapterProbe: Codable {
    let index: UInt32
    let name: String
    let identity: String
    let hardwareH264: [EncoderProbe]
}

private struct Probe: Codable {
    let `protocol`: Int
    let platform: String
    let platformBuild: String
    let videoCapture: Bool
    let processAudio: Bool
    let microphone = true
    let systemAudio: Bool
    let softwareVP8 = false
    let adapters: [AdapterProbe]
}

private struct CaptureTarget: Codable {
    let kind: String
    let sourceId: String
    let pid: UInt32?
    let creationTime: String?
    let title: String

    enum CodingKeys: String, CodingKey {
        case kind
        case sourceId
        case pid
        case creationTime
        case title
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(sourceId, forKey: .sourceId)
        try container.encodeIfPresent(pid, forKey: .pid)
        try container.encodeIfPresent(creationTime, forKey: .creationTime)
        try container.encode(title, forKey: .title)
    }
}

private struct StartingStatus: Codable {
    let state = "starting"
    let codec = "h264"
    let hardwareOnly = true
    let adapterIndex: UInt32 = 0
    let adapterName = "Apple VideoToolbox"
    let adapterIdentity = "apple-videotoolbox"
    let encoderIndex: UInt32 = 0
    let encoderName = "VideoToolbox H.264"
    let encoderIdentity = "com.apple.videotoolbox.h264"
    let outputs: [OutputProfile]
}

private struct ActiveStatus: Codable {
    let state = "active"
    let codec = "h264"
    let hardwareOnly = true
    let profileLevelId: String
    let width: Int
    let height: Int
    let fps: Int32
    let outputs: [OutputProfile]
}

private struct AudioStatus: Codable {
    let state = "active"
    let audio = true
}

private struct CaptureFailure: Error, CustomStringConvertible {
    let description: String
}

private func require(_ status: OSStatus, _ stage: String) throws {
    if status != noErr {
        throw CaptureFailure(description: "\(stage) failed (\(status))")
    }
}

private func later(_ first: CMTime, _ second: CMTime) -> CMTime {
    CMTimeCompare(first, second) >= 0 ? first : second
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    try FileHandle.standardOutput.write(contentsOf: data)
}

private func processCreationTime(_ pid: pid_t) -> String? {
    guard pid > 0 else {
        return nil
    }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
    let read = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, pointer, size)
    }
    guard read == size, info.pbi_start_tvsec > 0 else {
        return nil
    }
    let seconds = UInt64(info.pbi_start_tvsec)
    let microseconds = UInt64(info.pbi_start_tvusec)
    guard seconds <= (UInt64.max - microseconds) / 1_000_000 else {
        return nil
    }
    return String(seconds * 1_000_000 + microseconds)
}

private func target(for window: SCWindow) -> CaptureTarget? {
    guard let application = window.owningApplication,
          application.processID > 0,
          let created = processCreationTime(application.processID),
          let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines),
          !title.isEmpty else {
        return nil
    }
    return CaptureTarget(
        kind: "window",
        sourceId: String(window.windowID),
        pid: UInt32(application.processID),
        creationTime: created,
        title: title
    )
}

private func target(for display: SCDisplay) -> CaptureTarget {
    CaptureTarget(
        kind: "display",
        sourceId: String(display.displayID),
        pid: nil,
        creationTime: nil,
        title: "Display \(display.displayID)"
    )
}

private func shareableContent() async throws -> SCShareableContent {
    // Initialize the display service before ScreenCaptureKit builds filters.
    _ = CGMainDisplayID()
    return try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
    )
}

private func shareableWindows(_ content: SCShareableContent) -> [(SCWindow, CaptureTarget)] {
    return content.windows.compactMap { window in
        guard let value = target(for: window) else { return nil }
        return (window, value)
    }
}

private func probe() throws {
    let encoders = HardwareEncoder.isAvailable()
        ? [EncoderProbe(
            index: 0,
            name: "VideoToolbox H.264",
            identity: "com.apple.videotoolbox.h264"
        )]
        : []
    let adapters = encoders.isEmpty
        ? []
        : [AdapterProbe(
            index: 0,
            name: "Apple VideoToolbox",
            identity: "apple-videotoolbox",
            hardwareH264: encoders
        )]
    try writeJSON(Probe(
        protocol: captureProtocol,
        platform: "darwin",
        platformBuild: ProcessInfo.processInfo.operatingSystemVersionString,
        videoCapture: true,
        processAudio: true,
        systemAudio: true,
        adapters: adapters
    ))
}

private func listSources() async throws {
    let content = try await shareableContent()
    let displays = content.displays.map { target(for: $0) }.sorted {
        $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
    }
    let windows = shareableWindows(content).map { $0.1 }.sorted {
        $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
    }
    try writeJSON(Array((displays + windows).prefix(1024)))
}

private final class StopSignal {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var stopped = false
    private var failure: Error?

    func signal(_ error: Error? = nil) {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return
        }
        stopped = true
        failure = error
        lock.unlock()
        semaphore.signal()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func wait() throws {
        semaphore.wait()
        lock.lock()
        let error = failure
        lock.unlock()
        if let error { throw error }
    }
}

private func appendBigEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var encoded = value.bigEndian
    Swift.withUnsafeBytes(of: &encoded) { bytes in
        data.append(contentsOf: bytes)
    }
}

private final class ProtocolWriter {
    private let lock = NSLock()
    private let output: (Data) throws -> Void

    init(output: @escaping (Data) throws -> Void = { data in
        try FileHandle.standardOutput.write(contentsOf: data)
    }) {
        self.output = output
    }

    func writeStatus<T: Encodable>(_ status: T) throws {
        try write(kind: 3, flags: 0, timestamp: 0, duration: 0,
                  payload: JSONEncoder().encode(status))
    }

    func writeH264(
        _ payload: Data,
        keyFrame: Bool,
        layer: UInt8,
        profile: OutputProfile,
        timestamp: UInt64,
        duration: UInt64
    ) throws {
        try write(
            kind: 2,
            flags: keyFrame ? 1 : 0,
            layer: layer,
            width: UInt16(profile.width),
            height: UInt16(profile.height),
            timestamp: timestamp,
            duration: duration,
            payload: payload
        )
    }

    func beginFrame(timestamp: UInt64, duration: UInt64) throws {
        try write(kind: 5, flags: 0, timestamp: timestamp,
                  duration: duration, payload: Data())
    }

    func unavailable(layer: UInt8, error: Error) throws {
        let message = String(String(describing: error).prefix(256))
        try write(kind: 6, flags: 0, layer: layer, timestamp: 0,
                  duration: 0, payload: Data(message.utf8))
    }

    func writePCM(
        _ payload: Data,
        timestamp: UInt64,
        duration: UInt64
    ) throws {
        try write(
            kind: 1,
            flags: 0,
            timestamp: timestamp,
            duration: duration,
            payload: payload
        )
    }

    private func write(
        kind: UInt8,
        flags: UInt8,
        layer: UInt8 = 0,
        width: UInt16 = 0,
        height: UInt16 = 0,
        timestamp: UInt64,
        duration: UInt64,
        payload: Data
    ) throws {
        let maximum = (kind == 3 || kind == 6) ? 1_048_576 : maxPayloadBytes
        guard (kind == 5 || !payload.isEmpty), payload.count <= maximum else {
            throw CaptureFailure(description: "capture payload is outside its bound")
        }
        var envelope = Data([0x53, 0x4d, 0x45, 0x44, 2, kind, flags, layer])
        appendBigEndian(timestamp, to: &envelope)
        appendBigEndian(duration, to: &envelope)
        appendBigEndian(width, to: &envelope)
        appendBigEndian(height, to: &envelope)
        appendBigEndian(UInt32(payload.count), to: &envelope)
        envelope.append(payload)
        lock.lock()
        defer { lock.unlock() }
        try output(envelope)
    }
}

private func isKeyFrame(_ sample: CMSampleBuffer) -> Bool {
    guard let values = CMSampleBufferGetSampleAttachmentsArray(
        sample,
        createIfNecessary: false
    ) as? [[CFString: Any]], let first = values.first else {
        return true
    }
    return (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true
}

private func h264ParameterSets(_ format: CMFormatDescription) throws -> [Data] {
    var count = 0
    var headerLength: Int32 = 0
    try require(
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: nil,
            parameterSetSizeOut: nil,
            parameterSetCountOut: &count,
            nalUnitHeaderLengthOut: &headerLength
        ),
        "h264-parameter-count"
    )
    guard count >= 2, headerLength == 4 else {
        throw CaptureFailure(description: "unexpected H.264 parameter layout")
    }
    var result: [Data] = []
    for index in 0..<count {
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        try require(
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            ),
            "h264-parameter-set"
        )
        guard let pointer, size > 0 else {
            throw CaptureFailure(description: "empty H.264 parameter set")
        }
        result.append(Data(bytes: pointer, count: size))
    }
    let sps = result[0]
    guard sps.count >= 4, supportedH264Profile(sps[1], sps[2], sps[3]) else {
        throw CaptureFailure(description: "H.264 profile is outside the product envelope")
    }
    return result
}

private func supportedH264Profile(_ profile: UInt8, _ constraints: UInt8, _ level: UInt8) -> Bool {
    // RFC 6184 Table 5: equivalent Constrained Baseline tools, as in the Go reader.
    supportedH264Levels.contains(level) && (
        (profile == 0x42 && constraints & 0x4f == 0x40) ||
        (profile == 0x4d && constraints & 0x8f == 0x80) ||
        (profile == 0x58 && constraints & 0xcf == 0xc0)
    )
}

private func annexB(_ sample: CMSampleBuffer, keyFrame: Bool) throws -> (payload: Data, recovery: Bool) {
    guard let block = CMSampleBufferGetDataBuffer(sample),
          let format = CMSampleBufferGetFormatDescription(sample) else {
        throw CaptureFailure(description: "encoded H.264 sample is incomplete")
    }
    let totalLength = CMBlockBufferGetDataLength(block)
    guard totalLength > 0 else {
        throw CaptureFailure(description: "encoded H.264 sample is empty")
    }
    var encoded = Data(count: totalLength)
    let copyStatus = encoded.withUnsafeMutableBytes { bytes in
        CMBlockBufferCopyDataBytes(
            block,
            atOffset: 0,
            dataLength: totalLength,
            destination: bytes.baseAddress!
        )
    }
    try require(copyStatus, "h264-block-buffer")
    let bytes = [UInt8](encoded)
    var output = Data()
    let startCode: [UInt8] = [0, 0, 0, 1]
    if keyFrame {
        for parameter in try h264ParameterSets(format) {
            output.append(contentsOf: startCode)
            output.append(parameter)
        }
    }
    var offset = 0
    var hasIDR = false
    while offset + 4 <= totalLength {
        let size = Int(bytes[offset]) << 24 |
            Int(bytes[offset + 1]) << 16 |
            Int(bytes[offset + 2]) << 8 |
            Int(bytes[offset + 3])
        offset += 4
        guard size > 0, offset + size <= totalLength else {
            throw CaptureFailure(description: "invalid H.264 NAL length")
        }
        hasIDR = hasIDR || bytes[offset] & 0x1f == 5
        output.append(contentsOf: startCode)
        output.append(contentsOf: bytes[offset..<(offset + size)])
        offset += size
    }
    guard offset == totalLength else {
        throw CaptureFailure(description: "trailing H.264 sample bytes")
    }
    return (output, keyFrame && hasIDR)
}

private func h264ProfileLevelID(_ payload: Data) -> String? {
    let bytes = [UInt8](payload)
    guard bytes.count >= 8 else { return nil }
    for index in 0...(bytes.count - 8) where
        bytes[index] == 0 && bytes[index + 1] == 0 &&
        bytes[index + 2] == 0 && bytes[index + 3] == 1 &&
        bytes[index + 4] & 0x1f == 7 {
        return String(
            format: "%02x%02x%02x",
            bytes[index + 5],
            bytes[index + 6],
            bytes[index + 7]
        )
    }
    return nil
}

private final class HardwareEncoder {
    private struct Input {
        let image: VideoImage
        let timestamp: CMTime
    }

    private let writer: ProtocolWriter
    private let lock = NSLock()
    private let queue: DispatchQueue
    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var pending: Input?
    private var working = false
    private var encodingTimestamp = CMTime.invalid
    private var closed = false
    private var failed = false
    private var forceKeyFrame = true
    private var decodable = false
    private var desiredBitrate: Int
    private var currentBitrate: Int
    private var lastFrameBucket: Int64?
    private let sourceFrameRate: Int32
    private let preference: DegradationPreference
    private let profile: OutputProfile
    private var output: OutputProfile?
    private let layer: UInt8
    private let onActive: (String, OutputProfile) throws -> Void
    private let onFailure: (Error) -> Void

    init(
        writer: ProtocolWriter,
        done: StopSignal,
        profile sourceProfile: VideoProfile = defaultVideoProfile,
        output: OutputProfile? = nil,
        layer: UInt8 = 0,
        onActive: @escaping (String, OutputProfile) throws -> Void = { _, _ in },
        onFailure: ((Error) -> Void)? = nil
    ) {
        self.writer = writer
        let profile = output ?? OutputProfile(
            width: sourceProfile.width, height: sourceProfile.height,
            fps: sourceProfile.frameRate, bitrate: sourceProfile.bitrate
        )
        self.profile = profile
        self.sourceFrameRate = sourceProfile.frameRate
        self.preference = sourceProfile.preference
        self.layer = layer
        self.onActive = onActive
        self.onFailure = onFailure ?? { done.signal($0) }
        self.queue = DispatchQueue(label: "piik.capture.encoder.\(layer)")
        desiredBitrate = profile.bitrate
        currentBitrate = profile.bitrate
    }

    static func isAvailable() -> Bool {
        let encoder = HardwareEncoder(writer: ProtocolWriter(), done: StopSignal())
        defer { encoder.close() }
        do {
            _ = try encoder.queue.sync {
                try encoder.prepare(encoder.profile, bitrate: encoder.profile.bitrate)
            }
            return true
        } catch {
            return false
        }
    }

    // Called only by the encoder queue after the previous frame has completed.
    // A size change replaces this output's codec, not its capture or media route.
    private func prepare(_ requested: OutputProfile, bitrate: Int) throws -> Bool {
        if let output, output.width == requested.width, output.height == requested.height {
            return false
        }
        if let session { VTCompressionSessionInvalidate(session) }
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        session = nil
        transfer = nil
        output = nil
        let profile = requested
        let specification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        ] as CFDictionary
        let attributes: [String: Any] = [
            kCVPixelBufferWidthKey as String: profile.width,
            kCVPixelBufferHeightKey as String: profile.height,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var created: VTCompressionSession?
        try require(
            VTCompressionSessionCreate(
                allocator: nil,
                width: Int32(profile.width),
                height: Int32(profile.height),
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: specification,
                imageBufferAttributes: attributes as CFDictionary,
                compressedDataAllocator: nil,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &created
            ),
            "videotoolbox-create"
        )
        guard let created else {
            throw CaptureFailure(description: "VideoToolbox returned no encoder")
        }
        session = created
        do {
            try set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
            try set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
            try set(kVTCompressionPropertyKey_ProfileLevel,
                    kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
            try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
            try set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: profile.fps))
            try set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: profile.fps * 2))
            if preference != .balanced {
                try? set(
                    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
                    preference == .framerate ? kCFBooleanTrue : kCFBooleanFalse
                )
            }
            try require(VTPixelTransferSessionCreate(
                allocator: nil, pixelTransferSessionOut: &transfer
            ), "videotoolbox-scaler-create")
            guard let transfer else {
                throw CaptureFailure(description: "VideoToolbox returned no scaler")
            }
            try require(VTSessionSetProperty(transfer,
                key: kVTPixelTransferPropertyKey_ScalingMode,
                value: kVTScalingMode_CropSourceToCleanAperture), "videotoolbox-scale-mode")
            try require(VTCompressionSessionPrepareToEncodeFrames(created),
                        "videotoolbox-prepare")
            output = profile
            currentBitrate = bitrate
            lock.lock()
            decodable = false
            lock.unlock()
            return true
        } catch {
            VTCompressionSessionInvalidate(created)
            if let transfer { VTPixelTransferSessionInvalidate(transfer) }
            session = nil
            transfer = nil
            throw error
        }
    }

    private func set(_ key: CFString, _ value: CFTypeRef) throws {
        guard let session else {
            throw CaptureFailure(description: "VideoToolbox encoder is closed")
        }
        try require(VTSessionSetProperty(session, key: key, value: value),
                    "videotoolbox-property")
    }

    func requestKeyFrame() {
        lock.lock()
        forceKeyFrame = true
        lock.unlock()
    }

    func setBitrate(_ value: Int) {
        lock.lock()
        desiredBitrate = value
        lock.unlock()
    }

    func encode(_ image: VideoImage, timestamp: CMTime) {
        lock.lock()
        guard !closed, !failed else {
            lock.unlock()
            return
        }
        if profile.fps < sourceFrameRate {
            let bucket = CMTimeConvertScale(
                timestamp, timescale: profile.fps, method: .roundTowardZero
            ).value
            if lastFrameBucket == bucket {
                lock.unlock()
                return
            }
            lastFrameBucket = bucket
        }
        // One retained input can wait behind one encode; newer raw frames replace it.
        pending = Input(image: image, timestamp: timestamp)
        let start = !working
        working = true
        lock.unlock()
        if start { queue.async { self.encodePending() } }
    }

    private func encodePending() {
        lock.lock()
        guard !closed, !failed, let input = pending else {
            working = false
            lock.unlock()
            return
        }
        pending = nil
        var force = forceKeyFrame
        forceKeyFrame = false
        let bitrate = desiredBitrate
        encodingTimestamp = input.timestamp
        lock.unlock()
        do {
            let output = try input.image.fitted(to: profile)
            if try prepare(output, bitrate: bitrate) { force = true }
            guard let session else {
                throw CaptureFailure(description: "VideoToolbox encoder is unavailable")
            }
            if currentBitrate != bitrate {
                try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
                currentBitrate = bitrate
            }
            let image = try scaled(input.image.buffer, output: output)
            let properties = force
                ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
                : nil
            var synchronousFlags: VTEncodeInfoFlags = []
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: image,
                presentationTimeStamp: input.timestamp,
                duration: profile.frameInterval,
                frameProperties: properties,
                infoFlagsOut: &synchronousFlags
            ) { [self, image] status, flags, sample in
                _ = image
                defer { finish(input.timestamp) }
                do {
                    try require(status, "videotoolbox-output")
                    if flags.contains(.frameDropped) {
                        if force { requestKeyFrame() }
                        return
                    }
                    guard let sample, CMSampleBufferDataIsReady(sample) else {
                        throw CaptureFailure(description: "VideoToolbox output is not ready")
                    }
                    let encoded = try annexB(sample, keyFrame: isKeyFrame(sample))
                    let keyFrame = encoded.recovery
                    lock.lock()
                    let current = !closed && !failed &&
                        CMTimeCompare(encodingTimestamp, input.timestamp) == 0
                    let needsRecovery = !decodable && !keyFrame
                    if current && ((force && !keyFrame) || needsRecovery) {
                        forceKeyFrame = true
                    }
                    if current && keyFrame { decodable = true }
                    lock.unlock()
                    if !current || needsRecovery { return }
                    let payload = encoded.payload
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                    guard pts.isNumeric, CMTimeCompare(pts, .zero) >= 0 else {
                        throw CaptureFailure(description: "invalid H.264 timestamp")
                    }
                    try writer.writeH264(
                        payload, keyFrame: keyFrame, layer: layer, profile: output,
                        timestamp: UInt64(CMTimeConvertScale(
                            pts, timescale: 10_000_000, method: .roundTowardZero
                        ).value),
                        duration: 10_000_000 / UInt64(profile.fps)
                    )
                    if keyFrame {
                        guard let profileLevelId = h264ProfileLevelID(payload) else {
                            throw CaptureFailure(description: "H.264 key frame has no SPS profile")
                        }
                        try onActive(profileLevelId, output)
                    }
                } catch {
                    if force { requestKeyFrame() }
                    fail(error)
                }
            }
            try require(status, "videotoolbox-input")
            if synchronousFlags.contains(.frameDropped) {
                if force { requestKeyFrame() }
                finish(input.timestamp)
            }
        } catch {
            if force { requestKeyFrame() }
            fail(error)
            finish(input.timestamp)
        }
    }

    private func finish(_ timestamp: CMTime) {
        lock.lock()
        let current = encodingTimestamp.isValid &&
            CMTimeCompare(encodingTimestamp, timestamp) == 0
        if current { encodingTimestamp = .invalid }
        lock.unlock()
        if current { queue.async { self.encodePending() } }
    }

    private func scaled(_ image: CVImageBuffer, output: OutputProfile) throws -> CVPixelBuffer {
        let bounds = CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(image),
                            height: CVPixelBufferGetHeight(image))
        if Int(bounds.width) == output.width && Int(bounds.height) == output.height &&
            CVImageBufferGetCleanRect(image) == bounds {
            return image
        }
        guard let session, let transfer,
              let pool = VTCompressionSessionGetPixelBufferPool(session) else {
            throw CaptureFailure(description: "VideoToolbox scale buffers are unavailable")
        }
        var destination: CVPixelBuffer?
        try require(CVPixelBufferPoolCreatePixelBuffer(nil, pool, &destination),
                    "videotoolbox-scale-buffer")
        guard let destination else {
            throw CaptureFailure(description: "VideoToolbox returned no scale buffer")
        }
        try require(VTPixelTransferSessionTransferImage(
            transfer, from: image, to: destination
        ), "videotoolbox-scale")
        return destination
    }

    private func fail(_ error: Error) {
        lock.lock()
        let first = !failed && !closed
        failed = true
        pending = nil
        lock.unlock()
        if first { onFailure(error) }
    }

    func close() {
        lock.lock()
        let wasClosed = closed
        closed = true
        pending = nil
        lock.unlock()
        if wasClosed { return }
        queue.sync {
            if let session {
                _ = VTCompressionSessionCompleteFrames(
                    session, untilPresentationTimeStamp: .invalid
                )
                VTCompressionSessionInvalidate(session)
            }
            if let transfer { VTPixelTransferSessionInvalidate(transfer) }
            session = nil
            transfer = nil
        }
    }

    func flush() {
        queue.sync {
            if let session {
                _ = VTCompressionSessionCompleteFrames(
                    session, untilPresentationTimeStamp: .invalid
                )
            }
        }
    }
}

private final class EncoderGroup {
    private let writer: ProtocolWriter
    private let done: StopSignal
    private let profile: VideoProfile
    private let outputs: [OutputProfile]
    private let lock = NSLock()
    // Encoder callbacks cannot wait behind synchronous encoder retirement.
    private let lifecycle = NSLock()
    private let originalOutput: Int
    private var active = false
    private var failedLayers = Set<UInt8>()
    private var encoders: [HardwareEncoder?] = []
    private var bitrates: [Int]
    private var closed = false

    init(writer: ProtocolWriter, done: StopSignal, profile: VideoProfile,
         outputs: [OutputProfile], encoded: Bool = false) throws {
        self.writer = writer
        self.done = done
        self.profile = profile
        self.outputs = outputs
        self.originalOutput = encoded ? 0 : min(1, outputs.count - 1)
        self.bitrates = outputs.map(\.bitrate)
        self.encoders = Array(repeating: nil, count: outputs.count)
        try writer.writeStatus(StartingStatus(outputs: outputs))
        if !encoded {
            for index in 0...originalOutput { setActive(index, true) }
        }
    }

    private func reportActive(_ profileLevelId: String, output: OutputProfile) throws {
        lock.lock()
        let publish = !active
        active = true
        lock.unlock()
        if publish {
            try writer.writeStatus(ActiveStatus(
                profileLevelId: profileLevelId, width: output.width,
                height: output.height, fps: profile.frameRate, outputs: outputs
            ))
        }
    }

    private func unavailable(_ layer: UInt8, _ error: Error) {
        lock.lock()
        let first = failedLayers.insert(layer).inserted
        let allFailed = failedLayers.count == outputs.count
        let startupFailed = !active && Int(layer) == originalOutput
        lock.unlock()
        if first {
            do { try writer.unavailable(layer: layer, error: error) }
            catch { done.signal(error) }
        }
        if allFailed || startupFailed { done.signal(error) }
    }

    func encode(_ image: VideoImage, timestamp: CMTime) throws {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        if closed { return }
        guard timestamp.isNumeric, CMTimeCompare(timestamp, .zero) >= 0 else {
            throw CaptureFailure(description: "invalid capture timestamp")
        }
        try writer.beginFrame(
            timestamp: UInt64(CMTimeConvertScale(
                timestamp, timescale: 10_000_000, method: .roundTowardZero
            ).value),
            duration: 10_000_000 / UInt64(profile.frameRate)
        )
        for encoder in encoders { encoder?.encode(image, timestamp: timestamp) }
    }

    func requestKeyFrame(_ layer: Int) {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        for (index, encoder) in encoders.enumerated() where layer == -1 || index == layer {
            encoder?.requestKeyFrame()
        }
    }

    func setActive(_ index: Int, _ enabled: Bool) {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        if closed || enabled == (encoders[index] != nil) { return }
        if !enabled {
            let previous = encoders[index]
            encoders[index] = nil
            previous?.close()
            return
        }
        let layer = UInt8(index)
        lock.lock()
        failedLayers.remove(layer)
        lock.unlock()
        let encoder = HardwareEncoder(
            writer: writer, done: done, profile: profile,
            output: outputs[index], layer: layer,
            onActive: { [weak self] profileLevelId, output in
                guard let self, index == self.originalOutput else { return }
                try self.reportActive(profileLevelId, output: output)
            },
            onFailure: { [weak self] in self?.unavailable(layer, $0) }
        )
        encoder.setBitrate(bitrates[index])
        encoders[index] = encoder
    }

    func setBitrate(_ layer: Int, _ bitrate: Int) {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        bitrates[layer] = bitrate
        encoders[layer]?.setBitrate(bitrate)
    }

    func close() {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        closed = true
        for encoder in encoders { encoder?.close() }
        encoders = Array(repeating: nil, count: outputs.count)
    }
}

private final class EnvelopeCollector {
    private let lock = NSLock()
    private var values: [Data] = []

    func append(_ value: Data) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

private func syntheticPixelBuffer(
    width imageWidth: Int = width, height imageHeight: Int = height
) throws -> CVPixelBuffer {
    let attributes = [
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
    ] as CFDictionary
    var value: CVPixelBuffer?
    try require(
        CVPixelBufferCreate(
            kCFAllocatorDefault,
            imageWidth,
            imageHeight,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            attributes,
            &value
        ),
        "pixel-buffer-create"
    )
    guard let value, CVPixelBufferGetPlaneCount(value) == 2 else {
        throw CaptureFailure(description: "synthetic pixel buffer is invalid")
    }
    try require(CVPixelBufferLockBaseAddress(value, []), "pixel-buffer-lock")
    for plane in 0..<2 {
        guard let base = CVPixelBufferGetBaseAddressOfPlane(value, plane) else {
            CVPixelBufferUnlockBaseAddress(value, [])
            throw CaptureFailure(description: "synthetic pixel plane is unavailable")
        }
        let byte = plane == 0 ? 16 : 128
        memset(
            base,
            Int32(byte),
            CVPixelBufferGetBytesPerRowOfPlane(value, plane) *
                CVPixelBufferGetHeightOfPlane(value, plane)
        )
    }
    CVPixelBufferUnlockBaseAddress(value, [])
    return value
}

private func containsRequiredH264Units(_ envelope: Data) -> Bool {
    let bytes = [UInt8](envelope)
    guard bytes.count >= 37, bytes[5] == 2, bytes[6] & 1 == 1 else {
        return false
    }
    var types = Set<UInt8>()
    for index in 32..<(bytes.count - 4) where
        bytes[index] == 0 && bytes[index + 1] == 0 &&
        bytes[index + 2] == 0 && bytes[index + 3] == 1 {
        types.insert(bytes[index + 4] & 0x1f)
    }
    return types.isSuperset(of: [7, 8, 5])
}

private func selfTest() throws {
    let collector = EnvelopeCollector()
    let writer = ProtocolWriter(output: { collector.append($0) })
    let encoder = HardwareEncoder(writer: writer, done: StopSignal())
    defer { encoder.close() }
    let cases = [(1280, 720, 1280, 720), (720, 1280, 404, 720),
                 (1720, 720, 1280, 534), (640, 480, 640, 480), (1280, 720, 1280, 720)]
    for (index, item) in cases.enumerated() {
        let previous = collector.snapshot().count
        encoder.encode(
            VideoImage(try syntheticPixelBuffer(width: item.0, height: item.1)),
            timestamp: CMTime(value: Int64(index + 1), timescale: frameRate)
        )
        encoder.flush()
        guard let envelope = collector.snapshot().dropFirst(previous).first(where: containsRequiredH264Units),
              Int(envelope[24]) * 256 + Int(envelope[25]) == item.2,
              Int(envelope[26]) * 256 + Int(envelope[27]) == item.3 else {
            throw CaptureFailure(description: "hardware H.264 resize self-test failed at \(index)")
        }
    }
}

private func geometrySelfTest() throws {
    let profiles: [(UInt32, Bool)] = [
        (0x42c034, true), (0x42e034, true), (0x42c00a, true),
        (0x4d8034, true), (0x58c034, true),
        (0x4d0034, false), (0x640034, false), (0x42c035, false), (0x42c134, false),
    ]
    for (profile, expected) in profiles {
        guard supportedH264Profile(UInt8(profile >> 16), UInt8((profile >> 8) & 0xff),
                                   UInt8(profile & 0xff)) == expected else {
            throw CaptureFailure(description: "H.264 profile admission self-test failed")
        }
    }
    let buffer = try syntheticPixelBuffer()
    let ceiling = OutputProfile(width: 1280, height: 720, fps: frameRate, bitrate: bitrate)
    let rect = CGRect(x: 50, y: 40, width: 200, height: 300)
    let attachments: [SCStreamFrameInfo: Any] = [
        .contentRect: rect.dictionaryRepresentation,
        .scaleFactor: CGFloat(2), .contentScale: CGFloat(1),
    ]
    // Core Video returns a lower-left origin; the surface crop starts 80 px
    // from the top, so its lower edge is 720 - 80 - 600 = 40 px from the bottom.
    guard let image = VideoImage(buffer, attachments: attachments),
          try image.fitted(to: ceiling).width == 400,
          try image.fitted(to: ceiling).height == 600,
          CVImageBufferGetCleanRect(buffer) == CGRect(x: 100, y: 40, width: 400, height: 600) else {
        throw CaptureFailure(description: "capture content geometry self-test failed")
    }
    var upscaled = attachments
    upscaled[.contentScale] = CGFloat(2)
    guard let smaller = VideoImage(buffer, attachments: upscaled),
          try smaller.fitted(to: ceiling).width == 200,
          try smaller.fitted(to: ceiling).height == 300 else {
        throw CaptureFailure(description: "small capture was enlarged")
    }
    for value in [CGFloat(0), -.infinity, .nan] {
        var invalid = attachments
        invalid[.contentScale] = value
        guard VideoImage(buffer, attachments: invalid) == nil else {
            throw CaptureFailure(description: "invalid capture scale was accepted")
        }
    }
    var outside = attachments
    outside[.contentRect] = CGRect(x: 700, y: 0, width: 200, height: 300).dictionaryRepresentation
    guard VideoImage(buffer, attachments: outside) == nil else {
        throw CaptureFailure(description: "out-of-bounds capture content was accepted")
    }
    let fullHD = try syntheticPixelBuffer(width: 1920, height: 1080)
    var rounded: [SCStreamFrameInfo: Any] = [
        .contentRect: CGRect(x: 0, y: 0, width: 864.0000319480896,
                             height: 540.000019967556).dictionaryRepresentation,
        .scaleFactor: CGFloat(2), .contentScale: CGFloat(0.5837838053703308),
    ]
    guard VideoImage(fullHD, attachments: rounded) != nil,
          CVImageBufferGetCleanRect(fullHD).height == 1080 else {
        throw CaptureFailure(description: "fractional capture edge discarded a valid frame")
    }
    rounded[.contentRect] = CGRect(x: -0.00002, y: -0.00002,
                                  width: 960.00004, height: 540.00004).dictionaryRepresentation
    guard VideoImage(fullHD, attachments: rounded) != nil,
          CVImageBufferGetCleanRect(fullHD) == CGRect(x: 0, y: 0, width: 1920, height: 1080) else {
        throw CaptureFailure(description: "fractional capture origin escaped the surface")
    }
    rounded[.contentRect] = CGRect(x: 0, y: 0, width: 960, height: 540.5).dictionaryRepresentation
    guard VideoImage(fullHD, attachments: rounded) == nil else {
        throw CaptureFailure(description: "capture overflow beyond subpixel rounding was accepted")
    }
    // Generated Constrained Baseline: 3856x2176 storage, 3840x2160 visible.
    // Exercise CoreMedia's SPS interpretation without allocating a decoder.
    let sps = Data([0x67, 0x42, 0xc0, 0x33, 0xd9, 0x00, 0x3c, 0x40, 0x44,
                    0x78, 0x98, 0x9c, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00,
                    0x40, 0x00, 0x00, 0x0c, 0x23, 0xc6, 0x0c, 0x92])
    let pps = Data([0x68, 0xcb, 0x83, 0xcb, 0x20])
    let format = try h264InputFormat(sps: sps, pps: pps)
    guard CMVideoFormatDescriptionGetCleanAperture(format, originIsAtTopLeft: true) ==
        CGRect(x: 0, y: 0, width: 3840, height: 2160) else {
        throw CaptureFailure(description: "H.264 visible aperture self-test failed")
    }
    // Uncropped 5120x2880 exceeds the visible-picture budget. Raw SPS storage
    // and reference counts are validated by Go before reaching this process;
    // CoreMedia can fold SPS cropping into its reported format dimensions.
    let oversized = Data([0x67, 0x42, 0xc0, 0x34, 0xda, 0x00, 0x50, 0x00, 0x5a, 0x64])
    guard (try? h264InputFormat(sps: oversized, pps: pps)) == nil else {
        throw CaptureFailure(description: "H.264 oversized visible picture was accepted")
    }
}

private final class AudioCaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: ProtocolWriter
    private let done: StopSignal
    private var pending = Data()
    private var nextTimestamp: UInt64?
    private var active = false

    init(writer: ProtocolWriter, done: StopSignal) {
        self.writer = writer
        self.done = done
        pending.reserveCapacity(960 * 2 * MemoryLayout<Int16>.size * 2)
    }

    // The platform confirms startup; silence is not a failed capture. Call on
    // the sample queue so the ready status always precedes admitted PCM.
    func start() throws {
        guard !done.isStopped else { return }
        try writer.writeStatus(AudioStatus())
        active = true
    }

    private func append(_ sample: Float32) {
        let clipped = max(-1, min(1, sample))
        var value = Int16((clipped * Float32(Int16.max)).rounded()).littleEndian
        Swift.withUnsafeBytes(of: &value) { pending.append(contentsOf: $0) }
    }

    private func sample(
        _ buffer: AudioBuffer,
        index: Int,
        floatingPoint: Bool
    ) throws -> Float32 {
        guard let data = buffer.mData else {
            throw CaptureFailure(description: "audio buffer has no samples")
        }
        if floatingPoint {
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
            guard index >= 0, index < count else {
                throw CaptureFailure(description: "audio float buffer is truncated")
            }
            return data.assumingMemoryBound(to: Float32.self)[index]
        }
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
        guard index >= 0, index < count else {
            throw CaptureFailure(description: "audio integer buffer is truncated")
        }
        return Float32(data.assumingMemoryBound(to: Int16.self)[index]) /
            Float32(Int16.max)
    }

    private func append(_ sampleBuffer: CMSampleBuffer) throws {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let formatPointer = CMAudioFormatDescriptionGetStreamBasicDescription(
                description
              ) else {
            throw CaptureFailure(description: "audio format is unavailable")
        }
        let format = formatPointer.pointee
        let channels = Int(format.mChannelsPerFrame)
        let floatingPoint = format.mFormatFlags &
            kAudioFormatFlagIsFloat != 0
        let signedInteger = format.mFormatFlags &
            kAudioFormatFlagIsSignedInteger != 0
        let nonInterleaved = format.mFormatFlags &
            kAudioFormatFlagIsNonInterleaved != 0
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mSampleRate == 48_000,
              channels > 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              (floatingPoint && format.mBitsPerChannel == 32) ||
                (signedInteger && format.mBitsPerChannel == 16) else {
            throw CaptureFailure(description: "audio format is outside the PCM contract")
        }

        var requiredSize = 0
        try require(
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: &requiredSize,
                bufferListOut: nil,
                bufferListSize: 0,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                blockBufferOut: nil
            ),
            "audio-buffer-size"
        )
        guard requiredSize >= MemoryLayout<AudioBufferList>.size else {
            throw CaptureFailure(description: "audio buffer list is invalid")
        }
        let storage = UnsafeMutableRawPointer.allocate(
            byteCount: requiredSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { storage.deallocate() }
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        var blockBuffer: CMBlockBuffer?
        try require(
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: nil,
                bufferListOut: list,
                bufferListSize: requiredSize,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                blockBufferOut: &blockBuffer
            ),
            "audio-buffer-list"
        )
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0,
              (!nonInterleaved && buffers.count == 1) ||
                (nonInterleaved && buffers.count >= channels) else {
            throw CaptureFailure(description: "audio channel layout is invalid")
        }
        if nextTimestamp == nil {
            let time = CMTimeGetSeconds(
                CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            )
            nextTimestamp = time.isFinite && time >= 0
                ? UInt64(time * 10_000_000)
                : 0
        }
        for frame in 0..<frames {
            let left: Float32
            let right: Float32
            if nonInterleaved {
                left = try sample(buffers[0], index: frame, floatingPoint: floatingPoint)
                right = channels > 1
                    ? try sample(buffers[1], index: frame, floatingPoint: floatingPoint)
                    : left
            } else {
                left = try sample(
                    buffers[0],
                    index: frame * channels,
                    floatingPoint: floatingPoint
                )
                right = channels > 1
                    ? try sample(
                        buffers[0],
                        index: frame * channels + 1,
                        floatingPoint: floatingPoint
                    )
                    : left
            }
            append(left)
            append(right)
        }
    }

    // Microphone conversion and ScreenCaptureKit audio use the same PCM framing.
    func appendPCM(_ buffer: AVAudioPCMBuffer) throws {
        guard active, !done.isStopped, let samples = buffer.int16ChannelData else { return }
        pending.append(UnsafeRawPointer(samples[0]).assumingMemoryBound(to: UInt8.self),
                       count: Int(buffer.frameLength) * 4)
        try flushFrames()
    }

    private func flushFrames() throws {
        let frameBytes = 960 * 2 * MemoryLayout<Int16>.size
        while pending.count >= frameBytes {
            let payload = pending.prefix(frameBytes)
            try writer.writePCM(
                Data(payload),
                timestamp: nextTimestamp ?? 0,
                duration: 200_000
            )
            pending.removeFirst(frameBytes)
            nextTimestamp = (nextTimestamp ?? 0) + 200_000
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard active, !done.isStopped, outputType == .audio, sampleBuffer.isValid else { return }
        do {
            try append(sampleBuffer)
            try flushFrames()
        } catch {
            done.signal(error)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        done.signal(error)
    }
}

private func audioSelfTest() throws {
    let collector = EnvelopeCollector()
    let done = StopSignal()
    let output = AudioCaptureOutput(writer: ProtocolWriter(output: { collector.append($0) }), done: done)
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000,
                                    channels: 2, interleaved: true),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960),
          let samples = buffer.int16ChannelData else {
        throw CaptureFailure(description: "audio self-test buffer is unavailable")
    }
    buffer.frameLength = 960
    memset(samples[0], 0, 960 * 4)
    try output.appendPCM(buffer)
    guard collector.snapshot().isEmpty else {
        throw CaptureFailure(description: "audio was admitted before startup succeeded")
    }
    try output.start()
    let started = collector.snapshot()
    guard started.count == 1, started[0][5] == 3,
          let status = try JSONSerialization.jsonObject(with: Data(started[0].dropFirst(32))) as? [String: Any],
          status["state"] as? String == "active", status["audio"] as? Bool == true else {
        throw CaptureFailure(description: "silent audio did not become ready")
    }
    try output.appendPCM(buffer)
    let frames = collector.snapshot()
    guard frames.count == 2, frames[1][5] == 1, frames[1].count == 32 + 960 * 4 else {
        throw CaptureFailure(description: "audio ready did not precede PCM exactly once")
    }
    done.signal()
    try output.appendPCM(buffer)
    guard collector.snapshot().count == 2 else {
        throw CaptureFailure(description: "stopped audio continued writing PCM")
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let encoders: EncoderGroup
    private let done: StopSignal
    private let queue: DispatchQueue
    private let profile: VideoProfile
    private var lastImage: VideoImage?
    private var lastTimestamp = CMTime.invalid

    init(
        encoders: EncoderGroup,
        done: StopSignal,
        queue: DispatchQueue,
        profile: VideoProfile
    ) {
        self.encoders = encoders
        self.done = done
        self.queue = queue
        self.profile = profile
    }

    func control(_ command: CaptureControl) {
        queue.sync {
            switch command {
            case .keyFrame(let layer): encoders.requestKeyFrame(layer)
            case .active(let slot, let enabled): encoders.setActive(slot, enabled)
            case .bitrate(let layer, let bitrate): encoders.setBitrate(layer, bitrate)
            }
            do { try replayLastImage() }
            catch { done.signal(error) }
        }
    }

    private func replayLastImage() throws {
        guard let image = lastImage else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        guard now.isNumeric else { return }
        let timestamp = lastTimestamp.isValid
            ? later(now, CMTimeAdd(lastTimestamp, profile.timestampStep))
            : now
        lastTimestamp = timestamp
        try encoders.encode(image, timestamp: timestamp)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
              ) as? [[SCStreamFrameInfo: Any]],
              let attachments = attachments.first,
              let rawStatus = attachments[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let image = VideoImage(buffer, attachments: attachments) else {
            return
        }
        let capturedTimestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard capturedTimestamp.isValid else {
            return
        }
        let timestamp = lastTimestamp.isValid
            ? later(
                capturedTimestamp,
                CMTimeAdd(lastTimestamp, profile.timestampStep)
            )
            : capturedTimestamp
        lastImage = image
        lastTimestamp = timestamp
        do { try encoders.encode(image, timestamp: timestamp) }
        catch { done.signal(error) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        done.signal(error)
    }
}

private func captureFilter(
    kind: String,
    sourceID: UInt32,
    pid: UInt32,
    creationTime: String
) async throws -> SCContentFilter {
    let content = try await shareableContent()
    if kind == "window" {
        guard pid > 0, creationTime != "0",
              let selected = shareableWindows(content).first(where: {
                $0.0.windowID == sourceID && $0.1.pid == pid &&
                    $0.1.creationTime == creationTime
              })?.0 else {
            throw CaptureFailure(description: "capture target identity changed")
        }
        return SCContentFilter(desktopIndependentWindow: selected)
    }
    if kind == "display" {
        guard pid == 0, creationTime == "0",
              let selected = content.displays.first(where: {
                $0.displayID == sourceID
              }) else {
            throw CaptureFailure(description: "capture target identity changed")
        }
        return SCContentFilter(display: selected, excludingWindows: [])
    }
    throw CaptureFailure(description: "capture target kind is unsupported")
}

private func validVideoSize(_ width: Int, _ height: Int) -> Bool {
    width >= 2 && width <= maxVideoDimension && width % 2 == 0 &&
        height >= 2 && height <= maxVideoDimension && height % 2 == 0 &&
        ((width + 15) / 16) * ((height + 15) / 16) * 256 <= maxVideoPixels
}

private func validVideoFormat(_ width: Int, _ height: Int, _ fps: Int32) -> Bool {
    // Match the shared H.264 Level 5.2 receive ceiling, including numeric sizes.
    validVideoSize(width, height) && fps >= 1 && fps <= maxVideoFramerate &&
        ((width + 15) / 16) * ((height + 15) / 16) * Int(fps) <= 2_073_600
}

private func videoProfile(_ arguments: [String]) throws -> VideoProfile {
    guard arguments.count >= 28,
          arguments[10] == "--width", let width = Int(arguments[11]),
          arguments[12] == "--height", let height = Int(arguments[13]),
          arguments[14] == "--fps", let frameRate = Int32(arguments[15]),
          arguments[16] == "--bitrate", let bitrate = Int(arguments[17]),
          arguments[18] == "--preference",
          let preference = DegradationPreference(rawValue: arguments[19]),
          arguments[20] == "--codec",
          ["auto", "h264"].contains(arguments[21]),
          arguments[22] == "--protocol-v7" else {
        throw CaptureFailure(description: "invalid video profile arguments")
    }
    guard validVideoFormat(width, height, frameRate), width >= 4, height >= 4,
          bitrate >= 100_000, bitrate <= maxVideoBitrate else {
        throw CaptureFailure(description: "video profile is outside the product bounds")
    }
    return VideoProfile(
        width: width,
        height: height,
        frameRate: frameRate,
        bitrate: bitrate,
        preference: preference
    )
}

private func outputProfiles(_ arguments: [String], start: Int = 23,
                            source: VideoProfile? = nil) throws -> [OutputProfile] {
    let count = arguments.count - start
    guard count > 0, count % 5 == 0, count / 5 <= maxOutputs else {
        throw CaptureFailure(description: "invalid output profile count")
    }
    var result: [OutputProfile] = []
    for index in stride(from: start, to: arguments.count, by: 5) {
        guard arguments[index] == "--output",
              let width = Int(arguments[index + 1]),
              let height = Int(arguments[index + 2]),
              let fps = Int32(arguments[index + 3]),
              let bitrate = Int(arguments[index + 4]),
              validVideoFormat(width, height, fps),
              width <= (source?.width ?? maxVideoDimension), height <= (source?.height ?? maxVideoDimension),
              fps <= (source?.frameRate ?? maxVideoFramerate),
              bitrate >= 1000, bitrate <= (source?.bitrate ?? maxVideoBitrate) else {
            throw CaptureFailure(description: "output profile is outside source bounds")
        }
        result.append(OutputProfile(width: width, height: height, fps: fps, bitrate: bitrate))
    }
    if let source {
        let original = result[min(1, result.count - 1)]
        guard original.width == source.width,
              original.height == source.height, original.fps == source.frameRate,
              original.bitrate == source.bitrate else {
            throw CaptureFailure(description: "original output must match the source profile")
        }
    }
    return result
}

private struct EncodedInput {
    let payload: Data
    let timestamp: CMTime
    let duration: CMTime
}

private func readInput(done: StopSignal, outputs: [OutputProfile] = [],
                       handle: @escaping (CaptureControl) -> Void = { _ in },
                       video: ((EncodedInput) throws -> Void)? = nil) {
    DispatchQueue.global(qos: .userInitiated).async {
        func readExactly(_ count: Int) throws -> Data? {
            var result = Data()
            while result.count < count {
                let part = FileHandle.standardInput.readData(ofLength: count - result.count)
                if part.isEmpty {
                    if result.isEmpty { return nil }
                    throw CaptureFailure(description: "truncated capture control")
                }
                result.append(part)
            }
            return result
        }
        do {
            while let header = try readExactly(32) {
                func number(_ range: Range<Int>) -> UInt64 {
                    header[range].reduce(0) { ($0 << 8) | UInt64($1) }
                }
                let size = Int(number(28..<32))
                guard Array(header.prefix(5)) == [0x53, 0x4d, 0x45, 0x44, 2], size > 0 else {
                    throw CaptureFailure(description: "invalid native input envelope")
                }
                if header[5] == 2, let video {
                    let timestamp = number(8..<16), duration = number(16..<24)
                    let width = number(24..<26), height = number(26..<28)
                    guard size <= maxPayloadBytes, header[6] <= 1, header[7] == 0,
                          validVideoSize(Int(width), Int(height)),
                          timestamp <= UInt64(Int64.max) / 100,
                          duration > 0, duration <= UInt64(Int64.max) / 100,
                          let payload = try readExactly(size) else {
                        throw CaptureFailure(description: "invalid encoded input frame")
                    }
                    try video(EncodedInput(payload: payload,
                        timestamp: CMTime(value: Int64(timestamp), timescale: 10_000_000),
                        duration: CMTime(value: Int64(duration), timescale: 10_000_000)))
                    continue
                }
                guard header[5] == 7, header[6..<28].allSatisfy({ $0 == 0 }),
                      size <= 64, let payload = try readExactly(size),
                      payload.allSatisfy({ $0 >= 32 && $0 <= 126 }) else {
                    throw CaptureFailure(description: "invalid native control envelope")
                }
                let fields = String(decoding: payload, as: UTF8.self).split(whereSeparator: \.isWhitespace)
                if fields == ["Q"] {
                    done.signal()
                    return
                }
                var command: CaptureControl?
                if fields.count == 2, let value = Int(fields[1]) {
                    if fields[0] == "K", value >= -1, value < outputs.count {
                        command = .keyFrame(value)
                    }
                } else if fields.count == 3, fields[0] == "A",
                          let slot = Int(fields[1]), let enabled = Int(fields[2]),
                          outputs.indices.contains(slot), (0...1).contains(enabled) {
                    command = .active(slot, enabled == 1)
                } else if fields.count == 3, fields[0] == "B",
                          let layer = Int(fields[1]), let bitrate = Int(fields[2]),
                          outputs.indices.contains(layer),
                          bitrate >= 1000, bitrate <= outputs[layer].bitrate {
                    command = .bitrate(layer, bitrate)
                }
                guard let command, !outputs.isEmpty else {
                    done.signal(CaptureFailure(description: "invalid capture control"))
                    return
                }
                handle(command)
            }
            done.signal()
        } catch {
            done.signal(error)
        }
    }
}

private func h264InputFormat(sps: Data, pps: Data) throws -> CMVideoFormatDescription {
    var format: CMFormatDescription?
    let status = sps.withUnsafeBytes { first in
        pps.withUnsafeBytes { second in
            let pointers = [first.bindMemory(to: UInt8.self).baseAddress!,
                            second.bindMemory(to: UInt8.self).baseAddress!]
            let sizes = [sps.count, pps.count]
            return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                allocator: kCFAllocatorDefault, parameterSetCount: 2,
                parameterSetPointers: pointers, parameterSetSizes: sizes,
                nalUnitHeaderLength: 4, formatDescriptionOut: &format)
        }
    }
    try require(status, "decode-h264-format")
    guard let format else { throw CaptureFailure(description: "missing input format") }
    // Go owns raw SPS storage/reference admission. CoreMedia may report a
    // crop-normalized format; check that description and its aperture here.
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    let width = Int(dimensions.width), height = Int(dimensions.height)
    guard width >= 2, width <= maxCodedVideoDimension, width % 2 == 0,
          height >= 2, height <= maxCodedVideoDimension, height % 2 == 0,
          width * height <= maxCodedVideoPixels else {
        throw CaptureFailure(description: "decoded input format dimensions exceed their bound")
    }
    // The clean aperture owns visible size when the format retains padding.
    let area = CMVideoFormatDescriptionGetCleanAperture(format, originIsAtTopLeft: true)
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    guard area.minX.isFinite, area.minY.isFinite, area.width.isFinite, area.height.isFinite,
          area == area.integral, bounds.contains(area),
          validVideoSize(Int(area.width), Int(area.height)) else {
        throw CaptureFailure(description: "decoded input aperture exceeds its picture bound")
    }
    return format
}

private final class H264InputDecoder {
    private let encoders: EncoderGroup
    private let lock = NSLock()
    private var closed = false
    private var session: VTDecompressionSession?
    private var format: CMVideoFormatDescription?
    private var sps = Data()
    private var pps = Data()
    private var lastTimestamp = CMTime.invalid

    init(encoders: EncoderGroup) { self.encoders = encoders }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        closed = true
        if let session { VTDecompressionSessionInvalidate(session) }
        session = nil
    }

    func decode(_ input: EncodedInput) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw CaptureFailure(description: "encoded input is closed") }
        guard !lastTimestamp.isValid || CMTimeCompare(input.timestamp, lastTimestamp) > 0 else {
            throw CaptureFailure(description: "encoded input timestamp did not advance")
        }
        let bytes = [UInt8](input.payload)
        func nextPrefix(_ start: Int) -> (offset: Int, size: Int)? {
            var offset = start
            while offset + 3 <= bytes.count {
                if bytes[offset] == 0 && bytes[offset + 1] == 0 {
                    if bytes[offset + 2] == 1 { return (offset, 3) }
                    if offset + 4 <= bytes.count && bytes[offset + 2] == 0 && bytes[offset + 3] == 1 {
                        return (offset, 4)
                    }
                }
                offset += 1
            }
            return nil
        }
        guard var prefix = nextPrefix(0), prefix.offset == 0 else {
            throw CaptureFailure(description: "encoded H.264 input is not Annex-B")
        }
        var payload = Data(), nextSPS = sps, nextPPS = pps
        var recovery = false
        while true {
            let start = prefix.offset + prefix.size
            let next = nextPrefix(start)
            let end = next?.offset ?? bytes.count
            guard start < end else { throw CaptureFailure(description: "empty input NAL") }
            let nal = Data(bytes[start..<end])
            switch bytes[start] & 0x1f {
            case 7: nextSPS = nal
            case 8: nextPPS = nal
            case 5: recovery = true
            default: break
            }
            appendBigEndian(UInt32(nal.count), to: &payload)
            payload.append(nal)
            guard let next else { break }
            prefix = next
        }
        if format == nil || nextSPS != sps || nextPPS != pps {
            guard recovery, !nextSPS.isEmpty, !nextPPS.isEmpty else {
                throw CaptureFailure(description: "new H.264 input needs SPS, PPS and IDR")
            }
            let nextFormat = try h264InputFormat(sps: nextSPS, pps: nextPPS)
            if let session, !VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: nextFormat) {
                VTDecompressionSessionInvalidate(session)
                self.session = nil
            }
            format = nextFormat
            sps = nextSPS
            pps = nextPPS
        }
        guard let format else { throw CaptureFailure(description: "input format is unavailable") }
        if session == nil {
            let attributes: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ]
            try require(VTDecompressionSessionCreate(allocator: kCFAllocatorDefault,
                formatDescription: format, decoderSpecification: nil,
                imageBufferAttributes: attributes as CFDictionary, outputCallback: nil,
                decompressionSessionOut: &session), "decode-session")
        }
        var block: CMBlockBuffer?
        try require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault,
            memoryBlock: nil, blockLength: payload.count, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: payload.count,
            flags: 0, blockBufferOut: &block), "decode-block")
        guard let block, let session else { throw CaptureFailure(description: "decoder is unavailable") }
        try require(payload.withUnsafeBytes { bytes in
            CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block,
                offsetIntoDestination: 0, dataLength: payload.count)
        }, "decode-payload")
        var timing = CMSampleTimingInfo(duration: input.duration,
            presentationTimeStamp: input.timestamp, decodeTimeStamp: .invalid)
        var size = payload.count
        var sample: CMSampleBuffer?
        try require(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
            formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
            sampleBufferOut: &sample), "decode-sample")
        guard let sample else { throw CaptureFailure(description: "missing decoder sample") }
        var image: CVImageBuffer?
        var decodeStatus: OSStatus = noErr
        // No async/reordering flags: VideoToolbox completes this callback before returning.
        try require(VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample,
            flags: [], infoFlagsOut: nil, outputHandler: { status, _, decoded, _, _ in
                decodeStatus = status
                image = decoded
            }), "decode-frame")
        try require(decodeStatus, "decode-output")
        guard let image else { throw CaptureFailure(description: "decoder did not produce an image") }
        lastTimestamp = input.timestamp
        try encoders.encode(VideoImage(image), timestamp: input.timestamp)
    }
}

private func encodedVideo(_ arguments: [String]) throws {
    guard arguments.count >= 16, arguments[2] == "--codec", arguments[3] == "h264",
          arguments[4] == "--adapter-index", arguments[5] == "0",
          arguments[6] == "--mft-index", arguments[7] == "0",
          arguments[8] == "--preference",
          let preference = DegradationPreference(rawValue: arguments[9]),
          arguments[10] == "--protocol-v7" else {
        throw CaptureFailure(description: "invalid encoded video arguments")
    }
    let outputs = try outputProfiles(arguments, start: 11)
    let profile = VideoProfile(width: outputs.map(\.width).max()!, height: outputs.map(\.height).max()!,
        frameRate: outputs.map(\.fps).max()!, bitrate: outputs.map(\.bitrate).max()!, preference: preference)
    let done = StopSignal()
    let encoders = try EncoderGroup(writer: ProtocolWriter(), done: done, profile: profile,
        outputs: outputs, encoded: true)
    defer { encoders.close() }
    let decoder = H264InputDecoder(encoders: encoders)
    defer { decoder.close() }
    readInput(done: done, outputs: outputs, handle: { command in
        switch command {
        case .keyFrame(let layer): encoders.requestKeyFrame(layer)
        case .active(let slot, let enabled): encoders.setActive(slot, enabled)
        case .bitrate(let layer, let bitrate): encoders.setBitrate(layer, bitrate)
        }
    }, video: decoder.decode)
    try done.wait()
}

private func capture(_ arguments: [String]) async throws {
    guard arguments.count >= 28,
          arguments[1] == "--capture-video",
          let sourceID = UInt32(arguments[3]), sourceID > 0,
          let pid = UInt32(arguments[4]),
          arguments[6] == "--adapter-index", arguments[7] == "0",
          arguments[8] == "--mft-index", arguments[9] == "0" else {
        throw CaptureFailure(description: "invalid capture arguments")
    }
    let profile = try videoProfile(arguments)
    let profiles = try outputProfiles(arguments, source: profile)
    let kind = arguments[2]
    let creationTime = arguments[5]
    let filter = try await captureFilter(
        kind: kind,
        sourceID: sourceID,
        pid: pid,
        creationTime: creationTime
    )

    let writer = ProtocolWriter()
    let done = StopSignal()
    let encoders = try EncoderGroup(writer: writer, done: done, profile: profile, outputs: profiles)
    defer { encoders.close() }
    let captureQueue = DispatchQueue(label: "piik.capture.video")
    let output = CaptureOutput(
        encoders: encoders,
        done: done,
        queue: captureQueue,
        profile: profile
    )
    let configuration = SCStreamConfiguration()
    configuration.width = profile.width
    configuration.height = profile.height
    configuration.scalesToFit = true
    if #available(macOS 14.0, *) { configuration.preservesAspectRatio = true }
    configuration.minimumFrameInterval = profile.frameInterval
    configuration.queueDepth = 5
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.showsCursor = true
    let stream = SCStream(
        filter: filter,
        configuration: configuration,
        delegate: output
    )
    try stream.addStreamOutput(
        output,
        type: .screen,
        sampleHandlerQueue: captureQueue
    )
    readInput(done: done, outputs: profiles, handle: output.control)

    try await stream.startCapture()
    do {
        try done.wait()
    } catch {
        try? await stream.stopCapture()
        throw error
    }
    try await stream.stopCapture()
}

// AVAudioEngine callbacks never wait on stdout. Four copied buffers bound the
// worker; the persistent platform converter owns resampling between callbacks.
private func audioDeviceString(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value as String?
}

private func microphoneDevices() throws -> [(id: AudioDeviceID, uid: String, name: String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
          size <= 4096 else { throw CaptureFailure(description: "microphone list is unavailable") }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    if devices.isEmpty { return [] }
    let status = devices.withUnsafeMutableBytes { buffer in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, buffer.baseAddress!)
    }
    guard status == noErr else { throw CaptureFailure(description: "microphone list is unavailable") }
    return devices.compactMap { device in
        var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var bytes: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &input, 0, nil, &bytes) == noErr, bytes > 0,
              let uid = audioDeviceString(device, kAudioDevicePropertyDeviceUID),
              let name = audioDeviceString(device, kAudioObjectPropertyName) else { return nil }
        return (id: device, uid: uid, name: name)
    }
}

private func listMicrophones() throws {
    let devices = try microphoneDevices().prefix(64).map { ["id": $0.uid, "label": $0.name] }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: devices))
}

private func captureMicrophone(deviceUID: String = "") throws {
    let done = StopSignal()
    let control = DispatchQueue(label: "piik.microphone.control")
    let worker = DispatchQueue(label: "piik.microphone.pcm")
    let slots = DispatchSemaphore(value: 4)
    let output = AudioCaptureOutput(writer: ProtocolWriter(), done: done)
    var engine: AVAudioEngine?
    var observer: NSObjectProtocol?
    var tapped = false
    readInput(done: done)
    defer {
        control.sync {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            if tapped { engine?.inputNode.removeTap(onBus: 0) }
            engine?.stop()
            engine = nil
        }
        worker.sync {} // Queued work observes stopped; no tail audio is flushed.
    }
    let permitted: (Bool) -> Void = { allowed in
        control.async {
            guard !done.isStopped else { return }
            guard allowed else {
                done.signal(CaptureFailure(description: "microphone permission denied"))
                return
            }
            do {
                let capture = AVAudioEngine()
                engine = capture
                let input = capture.inputNode
                if !deviceUID.isEmpty {
                    guard let selected = try microphoneDevices().first(where: { $0.uid == deviceUID }),
                          let unit = input.audioUnit else { throw CaptureFailure(description: "selected microphone is unavailable") }
                    var device = selected.id
                    guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                               &device, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
                        throw CaptureFailure(description: "selected microphone could not open")
                    }
                }
                let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0, format.channelCount > 0,
                      let target = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                                sampleRate: 48_000, channels: 2, interleaved: true),
                      let converter = AVAudioConverter(from: format, to: target) else {
                    throw CaptureFailure(description: "microphone format is unavailable")
                }
                converter.channelMap = [0, format.channelCount > 1 ? 1 : 0]
                observer = NotificationCenter.default.addObserver(
                    forName: .AVAudioEngineConfigurationChange, object: capture, queue: nil
                ) { _ in done.signal(CaptureFailure(description: "microphone device changed")) }
                input.installTap(onBus: 0, bufferSize: 960, format: format) { buffer, _ in
                    guard !done.isStopped, buffer.frameLength > 0,
                          slots.wait(timeout: .now()) == .success else { return }
                    guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else {
                        slots.signal()
                        return
                    }
                    copy.frameLength = buffer.frameLength
                    let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                    let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
                    for index in 0..<source.count {
                        if let src = source[index].mData, let dst = destination[index].mData {
                            memcpy(dst, src, min(Int(source[index].mDataByteSize), Int(destination[index].mDataByteSize)))
                        }
                    }
                    worker.async {
                        defer { slots.signal() }
                        guard !done.isStopped else { return }
                        let capacity = AVAudioFrameCount(ceil(Double(copy.frameLength) * 48_000 / format.sampleRate)) + 64
                        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
                        var supplied = false
                        var error: NSError?
                        let status = converter.convert(to: converted, error: &error) { _, state in
                            if supplied { state.pointee = .noDataNow; return nil }
                            supplied = true
                            state.pointee = .haveData
                            return copy
                        }
                        if status == .error {
                            done.signal(error ?? CaptureFailure(description: "microphone conversion failed") as NSError)
                            return
                        }
                        do { try output.appendPCM(converted) } catch { done.signal(error) }
                    }
                }
                tapped = true
                try capture.start()
                try worker.sync { try output.start() }
            } catch { done.signal(error) }
        }
    }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: permitted(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: .audio, completionHandler: permitted)
    default: permitted(false)
    }
    try done.wait()
}

private func captureAudio(_ arguments: [String]) async throws {
    guard arguments.count == 5,
          arguments[1] == "--capture-audio",
          let pid = UInt32(arguments[3]) else {
        throw CaptureFailure(description: "invalid audio capture arguments")
    }
    let kind = arguments[2]
    let creationTime = arguments[4]
    let content = try await shareableContent()
    let filter: SCContentFilter
    if kind == "window" {
        guard pid > 0, creationTime != "0",
              let selected = shareableWindows(content).first(where: {
                $0.1.pid == pid && $0.1.creationTime == creationTime
              })?.0 else {
            throw CaptureFailure(description: "audio target identity changed")
        }
        guard let application = selected.owningApplication,
              let display = content.displays.first else {
            throw CaptureFailure(description: "audio application is unavailable")
        }
        filter = SCContentFilter(display: display, including: [application], exceptingWindows: [])
    } else if kind == "display" {
        guard pid == 0, creationTime == "0",
              let selected = content.displays.first else {
            throw CaptureFailure(description: "audio display is unavailable")
        }
        filter = SCContentFilter(display: selected, excludingWindows: [])
    } else {
        throw CaptureFailure(description: "audio target kind is unsupported")
    }
    let writer = ProtocolWriter()
    let done = StopSignal()
    let output = AudioCaptureOutput(writer: writer, done: done)
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    let queue = DispatchQueue(label: "piik.capture.audio")
    let stream = SCStream(
        filter: filter,
        configuration: configuration,
        delegate: output
    )
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)

    readInput(done: done)

    try await stream.startCapture()
    do {
        try queue.sync { try output.start() }
        try done.wait()
    } catch {
        try? await stream.stopCapture()
        throw error
    }
    try await stream.stopCapture()
}

@main
private struct PiikCapture {
    static func main() async {
        do {
            let arguments = CommandLine.arguments
            if arguments.count == 2, arguments[1] == "--probe" {
                try probe()
            } else if arguments.count == 2, arguments[1] == "--self-test" {
                try selfTest()
            } else if arguments.count == 2, arguments[1] == "--geometry-self-test" {
                try geometrySelfTest()
            } else if arguments.count == 2, arguments[1] == "--audio-self-test" {
                try audioSelfTest()
            } else if arguments.count == 2, arguments[1] == "--list" {
                try await listSources()
            } else if arguments.count == 2, arguments[1] == "--list-microphones" {
                try listMicrophones()
            } else if arguments.count == 2, arguments[1] == "--capture-microphone" {
                try captureMicrophone()
            } else if arguments.count == 4, arguments[1] == "--capture-microphone", arguments[2] == "--device", !arguments[3].isEmpty, arguments[3].utf8.count <= 512 {
                try captureMicrophone(deviceUID: arguments[3])
            } else if arguments.count > 1, arguments[1] == "--capture-audio" {
                try await captureAudio(arguments)
            } else if arguments.count > 1, arguments[1] == "--encoded-video" {
                try encodedVideo(arguments)
            } else {
                try await capture(arguments)
            }
        } catch {
            let message = "Piik capture unavailable: \(error)\n"
            FileHandle.standardError.write(message.data(using: .utf8) ?? Data())
            Darwin.exit(2)
        }
    }
}
