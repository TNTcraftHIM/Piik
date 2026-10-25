import UIKit
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import VideoToolbox
import PiikBridge
import Darwin
import os

// One instance belongs to one actual Go runtime. Late startup and OS callbacks
// can only close or update this instance, never a replacement started by the UI.
final class PiikRuntime: NSObject, PiikBridgePlatformProtocol {
#if canImport(ScreenCaptureKit)
    private final class Selection: NSObject, SCContentSharingPickerObserver {
        weak var owner: PiikRuntime?
        let id: Int64
        var presented = false
        var committed = false
        init(owner: PiikRuntime, id: Int64) { self.owner = owner; self.id = id }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
            DispatchQueue.main.async {
                guard let owner = self.owner, owner.selection === self, !owner.closed else { return }
                if self.committed { owner.capture?.update(filter, for: stream) }
                else if owner.core?.captureCurrent(self.id) == true {
                    self.committed = true; owner.capture?.select(filter, id: self.id)
                }
            }
        }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
            DispatchQueue.main.async {
                guard let owner = self.owner, owner.selection === self, !self.committed else { return }
                owner.clearSelection(); owner.core?.captureCanceled(self.id)
            }
        }
        func contentSharingPickerStartDidFailWithError(_ error: Error) {
            DispatchQueue.main.async {
                guard let owner = self.owner, owner.selection === self else { return }
                owner.clearSelection(); owner.core?.captureEnded(self.id); owner.captureFailed(error)
            }
        }
    }
#endif
    private let startup = DispatchQueue(label: "tv.piik.ios.runtime")
    private let log = Logger(subsystem: "tv.piik.ios", category: "Capture")
    private var lifecycleCore: PiikBridgeRuntime? // Only the startup queue creates and closes this resource.
    private var core: PiikBridgeRuntime?
#if canImport(ScreenCaptureKit)
    private var capture: ScreenCapture?
    private var selection: Selection?
#endif
    private var pendingVideo: [Int64: String] = [:]
    private var closed = false
    var ready: (String) -> Void = { _ in }
    var failed: (Error) -> Void = { _ in }
    var accessChanged: () -> Void = {}

    func start() {
        startup.async {
            do {
                let data = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true).appendingPathComponent("Piik")
                try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
#if canImport(ScreenCaptureKit)
                let supported = VideoEncoder.hardwareAvailable()
#else
                let supported = false // ScreenCaptureKit is absent from the simulator SDK.
#endif
                let catalog = "{\"platform\":\"ios\",\"provider\":\"VideoToolbox\",\"systemAudio\":false,\"encoders\":\(supported ? "[{\"name\":\"VideoToolbox AVC\",\"codec\":\"h264\"}]" : "[]")}"
                let candidate: PiikBridgeRuntime? = try PiikBridgeStart(self, Self.lanAddress(), catalog, data.path,
                                                                       NSTemporaryDirectory(), "", "")
                guard let next = candidate else {
                    throw NSError(domain: "Piik", code: 1, userInfo: [NSLocalizedDescriptionKey: "Piik runtime did not start."])
                }
                self.lifecycleCore = next
                DispatchQueue.main.async {
                    guard !self.closed else { return }
                    self.core = next
#if canImport(ScreenCaptureKit)
                    self.capture = ScreenCapture(core: next, needsPicker: { [weak self] id in self?.requestPicker(id) },
                        idle: { [weak self] in self?.clearSelection() }, report: { [weak self] error in self?.captureFailed(error) })
#endif
                    let waiting = self.pendingVideo; self.pendingVideo.removeAll()
                    for (id, configuration) in waiting { self.startVideo(id, configuration: configuration) }
                    self.ready(next.entryURL())
                }
            } catch { DispatchQueue.main.async { if !self.closed { self.report(error) } } }
        }
    }
    var managementURL: URL? { core.flatMap { URL(string: $0.url()) } }
    func trusts(_ url: URL) -> Bool { core?.trustedURL(url.absoluteString) == true }
    func becameActive() {
#if canImport(ScreenCaptureKit)
        presentPicker()
#endif
    }
    func close(completion: @escaping (Error?) -> Void) {
        closed = true; pendingVideo.removeAll()
#if canImport(ScreenCaptureKit)
        clearSelection(); capture?.close(); capture = nil
#endif
        core = nil
        // Startup and close share the same queue, including Stop during Start.
        // The UI may start a successor only after the actual Go close joins.
        startup.async {
            do {
                try self.lifecycleCore?.close(); self.lifecycleCore = nil
                DispatchQueue.main.async { completion(nil) }
            }
            catch { DispatchQueue.main.async { completion(error) } }
        }
    }
#if canImport(ScreenCaptureKit)
    private func requestPicker(_ id: Int64) {
        guard !closed, core?.captureCurrent(id) == true else { return }
        clearSelection()
        let next = Selection(owner: self, id: id); selection = next
        SCContentSharingPicker.shared.add(next)
        presentPicker()
    }
    private func presentPicker() {
        guard !closed, let selection, !selection.presented, UIApplication.shared.applicationState == .active,
              core?.captureCurrent(selection.id) == true else { return }
        selection.presented = true
        var configuration = SCContentSharingPickerConfiguration()
        configuration.showsCameraControl = false; configuration.showsMicrophoneControl = false
        let picker = SCContentSharingPicker.shared
        picker.defaultConfiguration = configuration; picker.isActive = true; picker.present()
    }
    private func clearSelection() {
        if let selection { SCContentSharingPicker.shared.remove(selection) }
        selection = nil; SCContentSharingPicker.shared.isActive = false
    }
#endif
    private func report(_ error: Error) { if !closed { failed(error) } }
    private func captureFailed(_ error: Error) {
        log.error("Native capture failed, code \((error as NSError).code)")
    }
    func startVideo(_ id_: Int64, configuration: String?) {
        DispatchQueue.main.async {
            guard !self.closed, let configuration else { return }
            guard let core = self.core else { self.pendingVideo[id_] = configuration; return }
            do {
                let value = try JSONDecoder().decode(CaptureConfiguration.self, from: Data(configuration.utf8))
                guard value.width >= 2, value.height >= 2, value.framerate > 0, value.bitrate > 0,
                      value.codec == "auto" || value.codec == "h264" else {
                    throw NSError(domain: "Piik", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unsupported capture configuration."])
                }
#if canImport(ScreenCaptureKit)
                self.capture?.add(id: id_, configuration: value)
#else
                core.captureEnded(id_)
#endif
            } catch { core.captureEnded(id_); self.captureFailed(error) }
        }
    }
    // The shared Web UI waits for the Go ACK; no other App needs foregrounding.
    func preparationDone(_ id_: Int64) {}
    func stop(_ id_: Int64) {
        DispatchQueue.main.async {
            self.pendingVideo.removeValue(forKey: id_)
#if canImport(ScreenCaptureKit)
            if self.selection?.id == id_ && self.selection?.committed == false { self.clearSelection() }
            self.capture?.remove(id: id_)
#endif
        }
    }
    func control(_ id_: Int64, command: String?, layer: Int64, value: Int64) {
#if canImport(ScreenCaptureKit)
        DispatchQueue.main.async { if let command { self.capture?.control(id: id_, command: command, layer: layer, value: value) } }
#endif
    }
    // Native audio is not advertised. Browser camera and room voice keep their
    // existing browser permission/capture owner instead of opening a second mic.
    func microphones(_ error: NSErrorPointer) -> String { "[]" }
    func startAudio(_ id_: Int64) { DispatchQueue.main.async { self.core?.captureEnded(id_) } }
    func startMicrophone(_ id_: Int64, deviceID: String?) { DispatchQueue.main.async { self.core?.captureEnded(id_) } }
    func siteAccessChanged() { DispatchQueue.main.async { if !self.closed { self.accessChanged() } } }
    func runtimeStopped(_ reason: String?) {
        DispatchQueue.main.async {
            guard !self.closed else { return }
            self.close { error in
                self.failed(error ?? NSError(domain: "Piik", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: reason ?? "Piik stopped."]))
            }
        }
    }
    private static func lanAddress() -> String {
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0 else { return "" }
        defer { freeifaddrs(addresses) }
        var item = addresses
        while let entry = item {
            defer { item = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                  entry.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                return String(cString: host)
            }
        }
        return ""
    }
}
