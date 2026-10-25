#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
import CoreMedia
import Foundation
import PiikBridge

// One physical stream owns background capture. A source replacement prepares
// its encoder beside the current sink without another picker or another stream.
final class ScreenCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private final class Sink {
        let id: Int64
        let encoder: VideoEncoder
        init(id: Int64, core: PiikBridgeRuntime, configuration: CaptureConfiguration,
             ready: @escaping (Bool) -> Void,
             fail: @escaping (Error) -> Void) {
            self.id = id
            var format = ""
            encoder = VideoEncoder(configuration: configuration, receive: { frame in
                let nextFormat = "\(frame.width):\(frame.height):\(frame.profile)"
                if format != nextFormat {
                    guard core.videoReady(id, codec: "h264", width: Int64(frame.width), height: Int64(frame.height),
                                          profile: frame.profile) else {
                        core.captureEnded(id); return
                    }
                    format = nextFormat
                }
                core.video(id, data: frame.data, ptsMicros: frame.pts, durationMicros: frame.duration, key: frame.key)
            }, ready: ready, fail: fail)
        }
    }
    private let core: PiikBridgeRuntime
    private let queue = DispatchQueue(label: "tv.piik.ios.capture")
    private var sinks: [Int64: Sink] = [:]
    private var stream: SCStream?
    private var lastImage: CVPixelBuffer?
    private var lastTimestamp = CMTime.invalid
    private var recovery: Set<Int64> = []
    private let needsPicker: (Int64) -> Void
    private let idle: () -> Void
    private let report: (Error) -> Void

    init(core: PiikBridgeRuntime, needsPicker: @escaping (Int64) -> Void,
         idle: @escaping () -> Void, report: @escaping (Error) -> Void) {
        self.core = core; self.needsPicker = needsPicker; self.idle = idle; self.report = report
    }
    func add(id: Int64, configuration: CaptureConfiguration) {
        queue.async {
            guard self.core.captureCurrent(id) else { return }
            self.sinks[id] = Sink(id: id, core: self.core, configuration: configuration, ready: { [weak self] retryRecovery in
                self?.queue.async {
                    guard let self, let sink = self.sinks[id] else { return }
                    if retryRecovery { sink.encoder.requestKeyFrame(); self.recovery.insert(id) }
                    self.replay(id: id)
                }
            }) { [weak self] error in
                self?.queue.async { self?.fail(id: id, error: error) }
            }
            self.recovery.insert(id); self.replay(id: id)
            if self.stream == nil { DispatchQueue.main.async { self.needsPicker(id) } }
        }
    }
    func select(_ filter: SCContentFilter, id: Int64) {
        queue.async {
            guard self.sinks[id] != nil, self.core.captureCurrent(id), self.stream == nil else { return }
            self.start(filter)
        }
    }
    func update(_ filter: SCContentFilter, for expected: SCStream?) {
        queue.async {
            guard let current = self.stream, expected === current else { return }
            self.start(filter)
        }
    }
    // iOS changes the OS-selected filter by replacing the physical SCStream.
    // Logical Go requests and their encoder ownership remain in this capture owner.
    private func start(_ filter: SCContentFilter) {
        let candidate = SCStream(filter: filter, configuration: configuration(for: filter), delegate: self)
        do { try candidate.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue) }
        catch { end(error: error); return }
        let previous = stream
        stream = candidate; lastImage = nil
        let begin = {
            self.queue.async {
                guard self.stream === candidate else { return }
                candidate.startCapture { error in
                    self.queue.async {
                        if self.stream === candidate, let error { self.end(error: error) }
                    }
                }
            }
        }
        if let previous { previous.stopCapture { _ in begin() } }
        else { begin() }
    }
    func control(id: Int64, command: String, layer: Int64, value: Int64) {
        queue.async {
            guard layer == 0, let sink = self.sinks[id] else { return }
            do {
                switch command {
                case "keyframe": sink.encoder.requestKeyFrame(); self.recovery.insert(id)
                case "active":
                    if sink.encoder.setActive(value != 0), value != 0 { self.recovery.insert(id) }
                case "bitrate": try sink.encoder.setBitrate(Int(value))
                default: break
                }
                self.replay(id: id)
            } catch { self.fail(id: id, error: error) }
        }
    }
    func remove(id: Int64) {
        queue.async {
            self.sinks.removeValue(forKey: id)?.encoder.close()
            self.recovery.remove(id)
            if self.sinks.isEmpty { self.stopStream() }
        }
    }
    func close() {
        queue.async {
            self.sinks.values.forEach { $0.encoder.close() }; self.sinks.removeAll()
            self.stopStream()
        }
    }
    private func stopStream() {
        let retired = stream; stream = nil; lastImage = nil; lastTimestamp = .invalid; recovery.removeAll()
        retired?.stopCapture { _ in }
        DispatchQueue.main.async { self.idle() }
    }
    private func fail(id: Int64, error: Error) {
        guard let sink = sinks.removeValue(forKey: id) else { return }
        recovery.remove(id)
        sink.encoder.close(); core.captureEnded(id)
        DispatchQueue.main.async { self.report(error) }
        if sinks.isEmpty { stopStream() }
    }
    private func end(error: Error) {
        let retired = sinks; sinks.removeAll(); stopStream()
        retired.values.forEach { $0.encoder.close(); core.captureEnded($0.id) }
        DispatchQueue.main.async { self.report(error) }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard self.stream === stream, type == .screen, CMSampleBufferDataIsReady(sample),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
              let image = CMSampleBufferGetImageBuffer(sample) else { return }
        let captured = CMSampleBufferGetPresentationTimeStamp(sample)
        guard captured.isNumeric else { return }
        let next = CMTimeAdd(lastTimestamp, CMTime(value: 1, timescale: 1_000_000))
        let time = lastTimestamp.isNumeric && CMTimeCompare(next, captured) > 0 ? next : captured
        lastImage = image; lastTimestamp = time
        for sink in Array(sinks.values) {
            do { if try sink.encoder.encode(image, at: time) { recovery.remove(sink.id) } }
            catch { fail(id: sink.id, error: error) }
        }
    }
    private func configuration(for filter: SCContentFilter) -> SCStreamConfiguration {
        let value = SCStreamConfiguration()
        value.capturesAudio = false
        value.width = max(2, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
        value.height = max(2, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        return value
    }
    // Retain one actual frame for explicit recovery and late admission on a static screen.
    // A busy encoder calls back when ready; no polling or fabricated image is needed.
    private func replay(id: Int64) {
        guard recovery.contains(id), let sink = sinks[id], let image = lastImage else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let next = CMTimeAdd(lastTimestamp, CMTime(value: 1, timescale: 1_000_000))
        let time = CMTimeCompare(now, next) > 0 ? now : next
        do {
            if try sink.encoder.encode(image, at: time) { lastTimestamp = time; recovery.remove(id) }
        } catch { fail(id: id, error: error) }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { if self.stream === stream { self.end(error: error) } }
    }
}
#endif
