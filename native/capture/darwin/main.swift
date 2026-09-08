import AudioToolbox
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
private let supportedH264Levels: Set<UInt8> = [
    0x1e, 0x1f, 0x20, 0x28, 0x29, 0x2a, 0x32, 0x33,
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
    try await SCShareableContent.excludingDesktopWindows(
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

private func hardwareH264Available() -> Bool {
    do {
        let encoder = try HardwareEncoder(
            writer: ProtocolWriter(),
            done: StopSignal()
        )
        encoder.close()
        return true
    } catch {
        return false
    }
}

private func probe() throws {
    let encoders = hardwareH264Available()
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
    try writeJSON(displays + windows)
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
    guard sps.count >= 4, sps[1] == 0x42, sps[2] == 0xc0,
          supportedH264Levels.contains(sps[3]) else {
        throw CaptureFailure(description: "H.264 profile is outside the product envelope")
    }
    return result
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
        let image: CVImageBuffer
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
    private let profile: OutputProfile
    private let layer: UInt8
    private let onActive: (String) throws -> Void
    private let onFailure: (Error) -> Void

    init(
        writer: ProtocolWriter,
        done: StopSignal,
        profile sourceProfile: VideoProfile = defaultVideoProfile,
        output: OutputProfile? = nil,
        layer: UInt8 = 0,
        onActive: @escaping (String) throws -> Void = { _ in },
        onFailure: ((Error) -> Void)? = nil
    ) throws {
        self.writer = writer
        let profile = output ?? OutputProfile(
            width: sourceProfile.width, height: sourceProfile.height,
            fps: sourceProfile.frameRate, bitrate: sourceProfile.bitrate
        )
        self.profile = profile
        self.sourceFrameRate = sourceProfile.frameRate
        self.layer = layer
        self.onActive = onActive
        self.onFailure = onFailure ?? { done.signal($0) }
        self.queue = DispatchQueue(label: "screener.capture.encoder.\(layer)")
        desiredBitrate = profile.bitrate
        currentBitrate = profile.bitrate
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
            try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: profile.bitrate))
            try set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: profile.fps))
            try set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: profile.fps * 2))
            if sourceProfile.preference != .balanced {
                try? set(
                    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
                    sourceProfile.preference == .framerate ? kCFBooleanTrue : kCFBooleanFalse
                )
            }
            try require(VTPixelTransferSessionCreate(
                allocator: nil, pixelTransferSessionOut: &transfer
            ), "videotoolbox-scaler-create")
            try require(VTCompressionSessionPrepareToEncodeFrames(created),
                        "videotoolbox-prepare")
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

    func encode(_ image: CVImageBuffer, timestamp: CMTime) {
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
        let force = forceKeyFrame
        forceKeyFrame = false
        let bitrate = desiredBitrate
        encodingTimestamp = input.timestamp
        lock.unlock()
        guard let session else { return }
        do {
            if currentBitrate != bitrate {
                try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
                currentBitrate = bitrate
            }
            let image = try scaled(input.image)
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
                        payload, keyFrame: keyFrame, layer: layer, profile: profile,
                        timestamp: UInt64(CMTimeConvertScale(
                            pts, timescale: 10_000_000, method: .roundTowardZero
                        ).value),
                        duration: 10_000_000 / UInt64(profile.fps)
                    )
                    if keyFrame {
                        guard let profileLevelId = h264ProfileLevelID(payload) else {
                            throw CaptureFailure(description: "H.264 key frame has no SPS profile")
                        }
                        try onActive(profileLevelId)
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

    private func scaled(_ image: CVImageBuffer) throws -> CVPixelBuffer {
        if CVPixelBufferGetWidth(image) == profile.width &&
            CVPixelBufferGetHeight(image) == profile.height {
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
            if encoders[originalOutput] == nil {
                close()
                throw CaptureFailure(description: "original hardware video output is unavailable")
            }
        }
    }

    private func reportActive(_ profileLevelId: String) throws {
        lock.lock()
        let publish = !active
        active = true
        lock.unlock()
        if publish {
            try writer.writeStatus(ActiveStatus(
                profileLevelId: profileLevelId, width: profile.width,
                height: profile.height, fps: profile.frameRate, outputs: outputs
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

    func encode(_ image: CVImageBuffer, timestamp: CMTime) throws {
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
        do {
            let encoder = try HardwareEncoder(
                writer: writer, done: done, profile: profile,
                output: outputs[index], layer: layer,
                onActive: { [weak self] profileLevelId in
                    guard let self, index == self.originalOutput else { return }
                    try self.reportActive(profileLevelId)
                },
                onFailure: { [weak self] in self?.unavailable(layer, $0) }
            )
            encoder.setBitrate(bitrates[index])
            encoders[index] = encoder
        } catch {
            unavailable(layer, error)
        }
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

private func syntheticPixelBuffer() throws -> CVPixelBuffer {
    let attributes = [
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
    ] as CFDictionary
    var value: CVPixelBuffer?
    try require(
        CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
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
    let encoder = try HardwareEncoder(writer: writer, done: StopSignal())
    encoder.encode(
        try syntheticPixelBuffer(),
        timestamp: CMTime(value: 1, timescale: frameRate)
    )
    encoder.flush()
    encoder.close()
    guard collector.snapshot().contains(where: containsRequiredH264Units) else {
        throw CaptureFailure(description: "hardware H.264 self-test produced no IDR")
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

    private func flushFrames() throws {
        let frameBytes = 960 * 2 * MemoryLayout<Int16>.size
        while pending.count >= frameBytes {
            if !active {
                try writer.writeStatus(AudioStatus())
                active = true
            }
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
        guard outputType == .audio, sampleBuffer.isValid else { return }
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

private final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let encoders: EncoderGroup
    private let done: StopSignal
    private let queue: DispatchQueue
    private let profile: VideoProfile
    private var lastImage: CVImageBuffer?
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
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let image = CMSampleBufferGetImageBuffer(sampleBuffer) else {
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
    let validResolution =
        (width == 854 && height == 480) ||
        (width == 1280 && height == 720) ||
        (width == 1920 && height == 1080) ||
        (width == 2560 && height == 1440)
    guard validResolution, frameRate >= 15, frameRate <= 60,
          bitrate >= 2_000_000, bitrate <= 12_000_000 else {
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
              width >= 2, width <= (source?.width ?? 2560), width % 2 == 0,
              height >= 2, height <= (source?.height ?? 1440), height % 2 == 0,
              fps >= 1, fps <= (source?.frameRate ?? 60),
              bitrate >= 1000, bitrate <= (source?.bitrate ?? 12_000_000) else {
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
                          width >= 2, width <= 2560, width % 2 == 0,
                          height >= 2, height <= 1440, height % 2 == 0,
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
            var nextFormat: CMFormatDescription?
            let status = nextSPS.withUnsafeBytes { first in
                nextPPS.withUnsafeBytes { second in
                    let pointers = [first.bindMemory(to: UInt8.self).baseAddress!, second.bindMemory(to: UInt8.self).baseAddress!]
                    let sizes = [nextSPS.count, nextPPS.count]
                    return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                        allocator: kCFAllocatorDefault, parameterSetCount: 2,
                        parameterSetPointers: pointers, parameterSetSizes: sizes,
                        nalUnitHeaderLength: 4, formatDescriptionOut: &nextFormat)
                }
            }
            try require(status, "decode-h264-format")
            guard let nextFormat else { throw CaptureFailure(description: "missing input format") }
            let dimensions = CMVideoFormatDescriptionGetDimensions(nextFormat)
            guard dimensions.width >= 2, dimensions.width <= 2560,
                  dimensions.height >= 2, dimensions.height <= 1440 else {
                throw CaptureFailure(description: "decoded input exceeds its dimension bound")
            }
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
        try encoders.encode(image, timestamp: input.timestamp)
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
    let captureQueue = DispatchQueue(label: "screener.capture.video")
    let output = CaptureOutput(
        encoders: encoders,
        done: done,
        queue: captureQueue,
        profile: profile
    )
    let configuration = SCStreamConfiguration()
    configuration.width = profile.width
    configuration.height = profile.height
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
        filter = SCContentFilter(desktopIndependentWindow: selected)
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
    let queue = DispatchQueue(label: "screener.capture.audio")
    let stream = SCStream(
        filter: filter,
        configuration: configuration,
        delegate: output
    )
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)

    readInput(done: done)

    try await stream.startCapture()
    do {
        try done.wait()
    } catch {
        try? await stream.stopCapture()
        throw error
    }
    try await stream.stopCapture()
}

@main
private struct ScreenerCapture {
    static func main() async {
        do {
            let arguments = CommandLine.arguments
            if arguments.count == 2, arguments[1] == "--probe" {
                try probe()
            } else if arguments.count == 2, arguments[1] == "--self-test" {
                try selfTest()
            } else if arguments.count == 2, arguments[1] == "--list" {
                try await listSources()
            } else if arguments.count > 1, arguments[1] == "--capture-audio" {
                try await captureAudio(arguments)
            } else if arguments.count > 1, arguments[1] == "--encoded-video" {
                try encodedVideo(arguments)
            } else {
                try await capture(arguments)
            }
        } catch {
            let message = "Screener capture unavailable: \(error)\n"
            FileHandle.standardError.write(message.data(using: .utf8) ?? Data())
            Darwin.exit(2)
        }
    }
}
