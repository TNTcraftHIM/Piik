import AudioToolbox
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

private let captureProtocol = 4
private let width = 1280
private let height = 720
private let frameRate: Int32 = 30
private let bitrate = 3_000_000
private let maxPayloadBytes = 1_048_576
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
}

private struct ActiveStatus: Codable {
    let state = "active"
    let codec = "h264"
    let hardwareOnly = true
    let profileLevelId: String
    let width: Int
    let height: Int
    let fps: Int32
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
        timestamp: UInt64,
        duration: UInt64
    ) throws {
        try write(
            kind: 2,
            flags: keyFrame ? 1 : 0,
            timestamp: timestamp,
            duration: duration,
            payload: payload
        )
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
    guard sps.count >= 4, sps[1] == 0x42, sps[2] == 0xc0,
          supportedH264Levels.contains(sps[3]) else {
        throw CaptureFailure(description: "H.264 profile is outside the product envelope")
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
    private let writer: ProtocolWriter
    private let done: StopSignal
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var forceKeyFrame = true
    private var active = false
    private var profileLevelId: String?
    private let profile: VideoProfile

    init(
        writer: ProtocolWriter,
        done: StopSignal,
        profile: VideoProfile = defaultVideoProfile
    ) throws {
        self.writer = writer
        self.done = done
        self.profile = profile
        let specification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        ] as CFDictionary
        var created: VTCompressionSession?
        try require(
            VTCompressionSessionCreate(
                allocator: nil,
                width: Int32(profile.width),
                height: Int32(profile.height),
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
        try set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: profile.bitrate))
        try set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: profile.frameRate))
        try set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: profile.frameRate * 2))
        if profile.preference != .balanced {
            try? set(
                kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
                profile.preference == .framerate ? kCFBooleanTrue : kCFBooleanFalse
            )
        }
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
            duration: profile.frameInterval,
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
                let observedProfileLevelId = keyFrame
                    ? h264ProfileLevelID(payload)
                    : nil
                let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
                guard seconds.isFinite, seconds >= 0 else {
                    throw CaptureFailure(description: "invalid H.264 timestamp")
                }
                try writer.writeH264(
                    payload,
                    keyFrame: keyFrame,
                    timestamp: UInt64(seconds * 10_000_000),
                    duration: 10_000_000 / UInt64(profile.frameRate)
                )
                lock.lock()
                if let observedProfileLevelId {
                    profileLevelId = observedProfileLevelId
                }
                let publishActive = !active
                let activeProfileLevelId = profileLevelId
                if activeProfileLevelId != nil {
                    active = true
                }
                lock.unlock()
                if publishActive {
                    guard let activeProfileLevelId else {
                        throw CaptureFailure(description: "H.264 key frame has no SPS profile")
                    }
                    try writer.writeStatus(ActiveStatus(
                        profileLevelId: activeProfileLevelId,
                        width: profile.width,
                        height: profile.height,
                        fps: profile.frameRate
                    ))
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
    private let encoder: HardwareEncoder
    private let done: StopSignal
    private let queue: DispatchQueue
    private let profile: VideoProfile
    private var lastImage: CVImageBuffer?
    private var lastTimestamp = CMTime.invalid
    private var lastRecoveryTime = CMTime.invalid

    init(
        encoder: HardwareEncoder,
        done: StopSignal,
        queue: DispatchQueue,
        profile: VideoProfile
    ) {
        self.encoder = encoder
        self.done = done
        self.queue = queue
        self.profile = profile
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
                    CMTimeAdd(lastRecoveryTime, profile.frameInterval)
               ) < 0 {
                return
            }
            lastRecoveryTime = now
            let next = lastTimestamp.isValid
                ? later(
                    now,
                    CMTimeAdd(lastTimestamp, profile.timestampStep)
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
                CMTimeAdd(lastTimestamp, profile.timestampStep)
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
    guard arguments.count == 23,
          arguments[10] == "--width", let width = Int(arguments[11]),
          arguments[12] == "--height", let height = Int(arguments[13]),
          arguments[14] == "--fps", let frameRate = Int32(arguments[15]),
          arguments[16] == "--bitrate", let bitrate = Int(arguments[17]),
          arguments[18] == "--preference",
          let preference = DegradationPreference(rawValue: arguments[19]),
          arguments[20] == "--codec",
          ["auto", "h264"].contains(arguments[21]),
          arguments[22] == "--protocol-v4" else {
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

private func capture(_ arguments: [String]) async throws {
    guard arguments.count == 23,
          arguments[1] == "--capture-video",
          let sourceID = UInt32(arguments[3]), sourceID > 0,
          let pid = UInt32(arguments[4]),
          arguments[6] == "--adapter-index", arguments[7] == "0",
          arguments[8] == "--mft-index", arguments[9] == "0" else {
        throw CaptureFailure(description: "invalid capture arguments")
    }
    let profile = try videoProfile(arguments)
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
    let encoder = try HardwareEncoder(writer: writer, done: done, profile: profile)
    defer { encoder.close() }
    let captureQueue = DispatchQueue(label: "screener.capture.video")
    let output = CaptureOutput(
        encoder: encoder,
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

    DispatchQueue.global(qos: .userInitiated).async {
        while true {
            let data = FileHandle.standardInput.readData(ofLength: 64)
            if data.isEmpty || data.contains(81) || data.contains(10) ||
                data.contains(13) {
                done.signal()
                return
            }
        }
    }

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
