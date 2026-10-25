import Foundation
import ScreenCaptureKit
import CoreMedia
import os

// iOS27 supplies its own background screen-capture lifetime, without an extension.
// This local probe encodes metadata only; it does not claim a Piik publication.
@available(iOS 27.0, *)
final class ScreenCaptureProbe: NSObject, SCStreamDelegate, SCStreamOutput {
    private final class Selection: NSObject, SCContentSharingPickerObserver {
        weak var owner: ScreenCaptureProbe?
        init(_ owner: ScreenCaptureProbe) { self.owner = owner }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
            DispatchQueue.main.async { [weak self] in
                guard let self, let owner = self.owner, owner.selection === self else { return }
                owner.selected(filter)
            }
        }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {}
        func contentSharingPickerStartDidFailWithError(_ error: Error) {
            DispatchQueue.main.async { [weak self] in
                guard let self, let owner = self.owner, owner.selection === self else { return }
                owner.log.error("Screen picker failed, code \((error as NSError).code)")
            }
        }
    }
    private var selection: Selection?
    private let queue = DispatchQueue(label: "tv.piik.ios.capture-probe")
    private var current: SCStream?
    private var encoder: VideoEncoder?
    private let log = Logger(subsystem: "tv.piik.ios", category: "ScreenCaptureProbe")

    func present() {
        let picker = SCContentSharingPicker.shared
        if let selection { picker.remove(selection) }
        let next = Selection(self)
        selection = next
        picker.add(next)
        var configuration = SCContentSharingPickerConfiguration()
        configuration.showsMicrophoneControl = false
        configuration.showsCameraControl = false
        picker.defaultConfiguration = configuration
        picker.isActive = true
        picker.present()
    }

    func close() {
        let picker = SCContentSharingPicker.shared
        if let selection { picker.remove(selection) }
        selection = nil
        picker.isActive = false
        queue.async {
            let retired = self.current
            self.current = nil
            self.encoder?.close()
            self.encoder = nil
            retired?.stopCapture { _ in }
        }
    }

    private func selected(_ filter: SCContentFilter) {
        queue.async {
            let old = self.current
            let config = SCStreamConfiguration()
            config.capturesAudio = false
            let candidate = SCStream(filter: filter, configuration: config, delegate: self)
            do { try candidate.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue) }
            catch { self.log.error("Screen output registration failed, code \((error as NSError).code)"); return }
            self.current = candidate
            self.encoder?.close()
            self.encoder = VideoEncoder()
            let start = {
                self.queue.async {
                    guard self.current === candidate else { return }
                    candidate.startCapture { error in
                        self.queue.async {
                            guard self.current === candidate else { return }
                            if let error {
                                self.current = nil
                                self.encoder?.close()
                                self.encoder = nil
                                self.log.error("Screen capture start failed, code \((error as NSError).code)")
                            } else { self.log.info("Local screen capture probe started") }
                        }
                    }
                }
            }
            if let old { old.stopCapture { _ in start() } } else { start() }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard current === stream, type == .screen,
              CMSampleBufferDataIsReady(sampleBuffer), let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        do { try encoder?.encode(image, at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) }
        catch {
            current = nil
            encoder?.close()
            encoder = nil
            stream.stopCapture { _ in }
            let status = (error as? VideoEncoder.EncoderError).map { Int($0.status) } ?? (error as NSError).code
            log.error("Screen encode failed, code \(status)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async {
            guard self.current === stream else { return }
            self.current = nil
            self.encoder?.close()
            self.encoder = nil
            self.log.info("Local screen capture probe stopped")
        }
    }
}
