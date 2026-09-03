import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

private let captureProtocol = 3
private let width = 1280
private let height = 720
private let frameRate: Int32 = 30
private let bitrate = 3_000_000
private let frameDuration100ns: UInt64 = 10_000_000 / UInt64(frameRate)
private let frameInterval = CMTime(value: 1, timescale: frameRate)
private let timestampStep = CMTime(value: 1, timescale: 90_000)
private let maxPayloadBytes = 1_048_576

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
    let hardwareOnly = true
    let adapterIndex: UInt32 = 0
    let adapterName = "Apple VideoToolbox"
    let adapterIdentity = "apple-videotoolbox"
    let encoderIndex: UInt32 = 0
    let encoderName = "VideoToolbox H.264"
    let encoderIdentity = "com.apple.videotoolbox.h264"
}

private struct ActiveStatus: Codable {
    let state = "active"
    let hardwareOnly = true
    let profileLevelId = "42c01f"
    let width = 1280
    let height = 720
    let fps = 30
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
        processAudio: false,
        systemAudio: false,
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

    func writeH264(_ payload: Data, keyFrame: Bool, timestamp: UInt64) throws {
        try write(
            kind: 2,
            flags: keyFrame ? 1 : 0,
            timestamp: timestamp,
            duration: frameDuration100ns,
            payload: payload
        )
    }

    private func write(
        kind: UInt8,
        flags: UInt8,
        timestamp: UInt64,
        duration: UInt64,
        payload: Data
    ) throws {
        guard !payload.isEmpty, payload.count <= maxPayloadBytes else {
            throw CaptureFailure(description: "capture payload is outside its bound")
        }
        var envelope = Data([0x53, 0x4d, 0x45, 0x44, 1, kind, flags, 0])
        appendBigEndian(timestamp, to: &envelope)
        appendBigEndian(duration, to: &envelope)
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
    guard sps.count >= 4, sps[1] == 0x42, sps[2] == 0xc0, sps[3] == 0x1f else {
        throw CaptureFailure(description: "H.264 profile differs from 42c01f")
    }
    return result
}

private func annexB(_ sample: CMSampleBuffer, keyFrame: Bool) throws -> Data {
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
    while offset + 4 <= totalLength {
        let size = Int(bytes[offset]) << 24 |
            Int(bytes[offset + 1]) << 16 |
            Int(bytes[offset + 2]) << 8 |
            Int(bytes[offset + 3])
        offset += 4
        guard size > 0, offset + size <= totalLength else {
            throw CaptureFailure(description: "invalid H.264 NAL length")
        }
        output.append(contentsOf: startCode)
        output.append(contentsOf: bytes[offset..<(offset + size)])
        offset += size
    }
    guard offset == totalLength else {
        throw CaptureFailure(description: "trailing H.264 sample bytes")
    }
    return output
}

private final class HardwareEncoder {
    private let writer: ProtocolWriter
    private let done: StopSignal
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var forceKeyFrame = true
    private var active = false

    init(writer: ProtocolWriter, done: StopSignal) throws {
        self.writer = writer
        self.done = done
        let specification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        ] as CFDictionary
        var created: VTCompressionSession?
        try require(
            VTCompressionSessionCreate(
                allocator: nil,
                width: Int32(width),
                height: Int32(height),
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: specification,
                imageBufferAttributes: nil,
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
        try set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        try set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        try set(kVTCompressionPropertyKey_ProfileLevel,
                kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
        try set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: frameRate))
        try set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 60))
        try require(VTCompressionSessionPrepareToEncodeFrames(created),
                    "videotoolbox-prepare")
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

    func encode(_ image: CVImageBuffer, timestamp: CMTime) {
        lock.lock()
        let force = forceKeyFrame
        forceKeyFrame = false
        let session = session
        lock.unlock()
        guard let session else { return }
        let properties = force
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            : nil
        var synchronousFlags: VTEncodeInfoFlags = []
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: image,
            presentationTimeStamp: timestamp,
            duration: CMTime(value: 1, timescale: frameRate),
            frameProperties: properties,
            infoFlagsOut: &synchronousFlags
        ) { [weak self] status, flags, sample in
            guard let self else { return }
            do {
                try require(status, "videotoolbox-output")
                if flags.contains(.frameDropped) {
                    if force { requestKeyFrame() }
                    return
                }
                guard let sample, CMSampleBufferDataIsReady(sample) else {
                    throw CaptureFailure(description: "VideoToolbox output is not ready")
                }
                let keyFrame = isKeyFrame(sample)
                lock.lock()
                let needsFirstKeyFrame = !active && !keyFrame
                if (force && !keyFrame) || needsFirstKeyFrame {
                    forceKeyFrame = true
                }
                lock.unlock()
                if needsFirstKeyFrame { return }
                let payload = try annexB(sample, keyFrame: keyFrame)
                let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
                guard seconds.isFinite, seconds >= 0 else {
                    throw CaptureFailure(description: "invalid H.264 timestamp")
                }
                try writer.writeH264(
                    payload,
                    keyFrame: keyFrame,
                    timestamp: UInt64(seconds * 10_000_000)
                )
                lock.lock()
                let publishActive = !active
                active = true
                lock.unlock()
                if publishActive {
                    try writer.writeStatus(ActiveStatus())
                }
            } catch {
                done.signal(error)
            }
        }
        if status != noErr {
            done.signal(CaptureFailure(
                description: "videotoolbox-input failed (\(status))"
            ))
        } else if synchronousFlags.contains(.frameDropped), force {
            requestKeyFrame()
        }
    }

    func close() {
        lock.lock()
        let current = session
        session = nil
        lock.unlock()
        guard let current else { return }
        _ = VTCompressionSessionCompleteFrames(
            current,
            untilPresentationTimeStamp: .invalid
        )
        VTCompressionSessionInvalidate(current)
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
    guard bytes.count > 32, bytes[5] == 2, bytes[6] & 1 == 1 else {
        return false
    }
    var types = Set<UInt8>()
    for index in 28..<(bytes.count - 4) where
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
    encoder.close()
    guard collector.snapshot().contains(where: containsRequiredH264Units) else {
        throw CaptureFailure(description: "hardware H.264 self-test produced no IDR")
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let encoder: HardwareEncoder
    private let done: StopSignal
    private let queue: DispatchQueue
    private var lastImage: CVImageBuffer?
    private var lastTimestamp = CMTime.invalid
    private var lastRecoveryTime = CMTime.invalid

    init(
        encoder: HardwareEncoder,
        done: StopSignal,
        queue: DispatchQueue
    ) {
        self.encoder = encoder
        self.done = done
        self.queue = queue
    }

    func requestKeyFrame() {
        queue.async { [weak self] in
            guard let self else { return }
            encoder.requestKeyFrame()
            guard let image = lastImage else { return }
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            guard now.isValid else { return }
            if lastRecoveryTime.isValid,
               CMTimeCompare(
                now,
                CMTimeAdd(lastRecoveryTime, frameInterval)
               ) < 0 {
                return
            }
            lastRecoveryTime = now
            let next = lastTimestamp.isValid
                ? later(
                    now,
                    CMTimeAdd(lastTimestamp, timestampStep)
                )
                : now
            lastTimestamp = next
            encoder.encode(image, timestamp: next)
        }
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
                CMTimeAdd(lastTimestamp, timestampStep)
            )
            : capturedTimestamp
        lastImage = image
        lastTimestamp = timestamp
        encoder.encode(image, timestamp: timestamp)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        done.signal(error)
    }
}

private func capture(_ arguments: [String]) async throws {
    guard arguments.count == 11,
          arguments[1] == "--capture-video",
          let sourceID = UInt32(arguments[3]), sourceID > 0,
          let pid = UInt32(arguments[4]),
          arguments[6] == "--adapter-index", arguments[7] == "0",
          arguments[8] == "--mft-index", arguments[9] == "0",
          arguments[10] == "--protocol-v3" else {
        throw CaptureFailure(description: "invalid capture arguments")
    }
    let kind = arguments[2]
    let creationTime = arguments[5]
    let content = try await shareableContent()
    let filter: SCContentFilter
    if kind == "window" {
        guard pid > 0, creationTime != "0",
              let selected = shareableWindows(content).first(where: {
                $0.0.windowID == sourceID && $0.1.pid == pid &&
                    $0.1.creationTime == creationTime
              })?.0 else {
            throw CaptureFailure(description: "capture target identity changed")
        }
        filter = SCContentFilter(desktopIndependentWindow: selected)
    } else if kind == "display" {
        guard pid == 0, creationTime == "0",
              let selected = content.displays.first(where: {
                $0.displayID == sourceID
              }) else {
            throw CaptureFailure(description: "capture target identity changed")
        }
        filter = SCContentFilter(display: selected, excludingWindows: [])
    } else {
        throw CaptureFailure(description: "capture target kind is unsupported")
    }

    let writer = ProtocolWriter()
    let done = StopSignal()
    let encoder = try HardwareEncoder(writer: writer, done: done)
    defer { encoder.close() }
    let captureQueue = DispatchQueue(label: "screener.capture.video")
    let output = CaptureOutput(
        encoder: encoder,
        done: done,
        queue: captureQueue
    )
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: frameRate)
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
    try writer.writeStatus(StartingStatus())

    DispatchQueue.global(qos: .userInitiated).async {
        while true {
            let data = FileHandle.standardInput.readData(ofLength: 64)
            if data.isEmpty {
                done.signal()
                return
            }
            for byte in data {
                if byte == 75 {
                    output.requestKeyFrame()
                } else if byte == 81 || byte == 10 || byte == 13 {
                    done.signal()
                    return
                }
            }
        }
    }

    try await stream.startCapture()
    do {
        try done.wait()
    } catch {
        try? await stream.stopCapture()
        encoder.close()
        throw error
    }
    try await stream.stopCapture()
    encoder.close()
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
