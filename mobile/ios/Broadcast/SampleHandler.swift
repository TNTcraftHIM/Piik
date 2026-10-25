import ReplayKit
import CoreMedia
import CoreVideo
import os

// A local capture/encode probe. It sends no media and advertises no Native service.
final class SampleHandler: RPBroadcastSampleHandler {
    private var encoder: VideoEncoder?
    private var appAudioSeen = false
    private let log = Logger(subsystem: "tv.piik.ios", category: "CaptureProbe")

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        log.info("Local capture probe started; no room transport attached")
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        autoreleasepool {
            do {
                switch sampleBufferType {
                case .video:
                    guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                    if encoder == nil { encoder = VideoEncoder() }
                    try encoder?.encode(image, at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
                case .audioApp:
                    if !appAudioSeen {
                        appAudioSeen = true
                        log.info("ReplayKit supplied application audio; samples are not retained")
                    }
                case .audioMic:
                    // The probe does not request or consume commentary input.
                    break
                @unknown default: break
                }
            } catch {
                encoder?.close()
                encoder = nil
                finishBroadcastWithError(error)
            }
        }
    }

    override func broadcastPaused() { encoder?.close(); encoder = nil }
    override func broadcastResumed() { log.info("Local capture probe resumed") }
    override func broadcastFinished() {
        encoder?.close()
        encoder = nil
        log.info("Local capture probe finished")
    }
}
