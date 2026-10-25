import Foundation
#if os(iOS)
import BackgroundTasks
import UIKit
#endif

// One admitted system task and one Go runtime share the same user-started lifetime.
// A late task callback can never adopt a newer session's runtime.
final class CompanionSession {
    enum State: Equatable {
        case stopped, admitting, starting, running, stopping, failed(String)
    }
    private final class Attempt {
        let identifier = Bundle.main.bundleIdentifier! + ".session." + UUID().uuidString
        var task: BGContinuedProcessingTask?
        var runtime: PiikRuntime?
        var timer: Timer?
        let started = ProcessInfo.processInfo.systemUptime
    }
    private var current: Attempt?
    private let submissions = DispatchQueue(label: "tv.piik.ios.session.submission")
    private(set) var state = State.stopped { didSet { changed() } }
    var changed: () -> Void = {}
    var preparationFinished: () -> Void = {}
    var browserFailed: () -> Void = {}

    func start(openBrowser: Bool) {
        guard current == nil, UIApplication.shared.applicationState == .active else { return }
        let attempt = Attempt()
        current = attempt
        state = .admitting
        let scheduler = BGTaskScheduler.shared
        // Continued processing permits per-job registration. Register and submit
        // the same concrete identifier; the plist alone uses the wildcard base.
        guard scheduler.register(forTaskWithIdentifier: attempt.identifier, using: .main, launchHandler: { [weak self] task in
            guard let self, let continued = task as? BGContinuedProcessingTask,
                  self.current === attempt, self.state == .admitting else {
                task.setTaskCompleted(success: false)
                return
            }
            self.adopt(continued, attempt: attempt, openBrowser: openBrowser)
        }) else {
            stop(reason: NSLocalizedString("The system could not register this Piik session.", comment: "Background task registration failed"))
            return
        }
        let request = BGContinuedProcessingTaskRequest(identifier: attempt.identifier, title: "Piik",
            subtitle: NSLocalizedString("Starting your session", comment: "Background session admission"))
        request.strategy = .fail
        // iOS 27 reports all submission failures asynchronously and requires
        // submission off the main thread. Actual task delivery still owns readiness.
        submissions.async { [weak self] in
            scheduler.submitTaskRequest(request) { error in
                DispatchQueue.main.async {
                    guard let self, self.current === attempt else {
                        scheduler.cancel(taskRequestWithIdentifier: attempt.identifier)
                        return
                    }
                    if error != nil {
                        self.stop(reason: NSLocalizedString("Background execution is unavailable. Allow Background App Refresh for Piik, then try again.", comment: "Background admission rejected"))
                    }
                }
            }
        }
    }

    private func adopt(_ task: BGContinuedProcessingTask, attempt: Attempt, openBrowser: Bool) {
        attempt.task = task
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.current === attempt else { return }
                self.stop(reason: NSLocalizedString("The system ended this session. Start Piik again to reconnect.", comment: "Background session expired or cancelled"))
            }
        }
        // Session duration is unknown. Report elapsed time without inventing a
        // completion percentage or an automatic maximum session duration.
        task.progress.totalUnitCount = -1
        updateProgress(attempt)
        attempt.timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.updateProgress(attempt)
        }
        let runtime = PiikRuntime()
        attempt.runtime = runtime
        runtime.ready = { [weak self] _ in
            guard let self, self.current === attempt, self.state == .starting else { return }
            self.state = .running
            if openBrowser { self.openEntry() }
        }
        runtime.failed = { [weak self] error in
            guard let self, self.current === attempt else { return }
            self.stop(reason: error.localizedDescription)
        }
        runtime.prepared = { [weak self] in
            guard let self, self.current === attempt else { return }
            self.preparationFinished()
        }
        state = .starting
        runtime.start()
    }

    private func updateProgress(_ attempt: Attempt) {
        guard current === attempt, let task = attempt.task else { return }
        let seconds = Int64(ProcessInfo.processInfo.systemUptime - attempt.started)
        task.progress.completedUnitCount = seconds
        let elapsed = String(format: "%lld:%02lld", seconds / 60, seconds % 60)
        task.updateTitle("Piik", subtitle: String(format: NSLocalizedString("Session active · %@", comment: "Elapsed session time in system status"), elapsed))
    }

    func becameActive() { current?.runtime?.becameActive() }

    func stop(reason: String? = nil) {
        guard let attempt = current, state != .stopping else { return }
        state = .stopping
        attempt.timer?.invalidate(); attempt.timer = nil
        attempt.task?.expirationHandler = nil
        if attempt.task == nil {
            submissions.async { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: attempt.identifier) }
        }
        let finish: (Error?) -> Void = { [weak self] error in
            guard let self, self.current === attempt else { return }
            attempt.task?.setTaskCompleted(success: reason == nil && error == nil)
            attempt.task = nil; attempt.runtime = nil
            self.current = nil
            if let detail = reason ?? error?.localizedDescription { self.state = .failed(detail) }
            else { self.state = .stopped }
        }
        if let runtime = attempt.runtime { runtime.close(completion: finish) }
        else { finish(nil) }
    }

    func openEntry() { open(current?.runtime?.entryURL) }
    func openManagement() { open(current?.runtime?.managementURL) }
    private func open(_ url: URL?) {
        guard state == .running, let attempt = current, let url else { return }
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            if !opened {
                DispatchQueue.main.async {
                    guard let self, self.current === attempt, self.state == .running else { return }
                    self.browserFailed()
                }
            }
        }
    }
}
