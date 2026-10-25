import Foundation
import Dispatch
import Darwin

// Replace only the OS and Go boundaries. The production CompanionSession owns
// admission, runtime creation, browser opening and retirement in every check.
struct Bundle {
    static let main = Bundle()
    let bundleIdentifier: String? = "tv.piik.ios"
}
final class UIApplication {
    enum State { case active, background }
    static let shared = UIApplication()
    var applicationState = State.active
    var opened: [URL] = []
    var completions: [(Bool) -> Void] = []
    func open(_ url: URL, options: [String: Any], completionHandler: @escaping (Bool) -> Void) {
        opened.append(url); completions.append(completionHandler)
    }
}
class BGTask {
    let identifier: String
    var expirationHandler: (() -> Void)?
    var completed: [Bool] = []
    init(_ identifier: String) { self.identifier = identifier }
    func setTaskCompleted(success: Bool) { completed.append(success) }
}
final class BGContinuedProcessingTask: BGTask {
    let progress = Progress(totalUnitCount: 0)
    func updateTitle(_ title: String, subtitle: String) {}
}
final class BGContinuedProcessingTaskRequest {
    enum Strategy { case queue, fail }
    let identifier: String
    var strategy = Strategy.queue
    init(identifier: String, title: String, subtitle: String) { self.identifier = identifier }
}
final class BGTaskScheduler {
    static let shared = BGTaskScheduler()
    var handlers: [String: (BGTask) -> Void] = [:]
    var submitted: [BGContinuedProcessingTaskRequest] = []
    var rejected = false
    func register(forTaskWithIdentifier identifier: String, using queue: DispatchQueue?, launchHandler: @escaping (BGTask) -> Void) -> Bool {
        precondition(handlers[identifier] == nil, "registered a task identifier twice")
        handlers[identifier] = launchHandler; return true
    }
    func submit(_ request: BGContinuedProcessingTaskRequest) throws {
        if rejected { throw CheckFailure("system rejected admission") }
        submitted.append(request)
    }
    func cancel(taskRequestWithIdentifier identifier: String) {}
    func deliver(_ identifier: String) -> BGContinuedProcessingTask {
        let task = BGContinuedProcessingTask(identifier)
        handlers[identifier]!(task)
        return task
    }
}
final class PiikRuntime {
    static var instances: [PiikRuntime] = []
    var ready: (String) -> Void = { _ in }
    var failed: (Error) -> Void = { _ in }
    var prepared: () -> Void = {}
    var closing: ((Error?) -> Void)?
    var managementURL: URL? { URL(string: "http://127.0.0.1:8787/client") }
    init() { Self.instances.append(self) }
    func start() {}
    func becameActive() {}
    func close(completion: @escaping (Error?) -> Void) { closing = completion }
}
struct CheckFailure: Error { let detail: String; init(_ detail: String) { self.detail = detail } }
func check(_ value: Bool, _ detail: String) throws { if !value { throw CheckFailure(detail) } }
func flushMain() { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02)) }

func run() throws {
    let scheduler = BGTaskScheduler.shared
    let session = CompanionSession()
    session.start(openBrowser: true)
    let cancelledID = scheduler.submitted.last!.identifier
    try check(PiikRuntime.instances.isEmpty && UIApplication.shared.opened.isEmpty, "submission started the runtime/browser before actual admission")
    session.stop()
    session.start(openBrowser: true)
    let currentID = scheduler.submitted.last!.identifier
    let late = scheduler.deliver(cancelledID)
    try check(late.completed == [false] && PiikRuntime.instances.isEmpty, "a cancelled task adopted the replacement session")
    let task = scheduler.deliver(currentID)
    let runtime = PiikRuntime.instances.last!
    try check(session.state == .starting && UIApplication.shared.opened.isEmpty, "browser opened before Go readiness")
    runtime.ready("http://127.0.0.1:8787/client")
    try check(session.state == .running && UIApplication.shared.opened.count == 1, "admitted ready runtime did not open the browser")
    try check(task.progress.isIndeterminate && !task.progress.isFinished, "session invented a completion fraction")
    let originalOpen = UIApplication.shared.completions.last!
    session.stop()
    session.start(openBrowser: false)
    try check(scheduler.submitted.last!.identifier == currentID, "replacement started before previous Go close joined")
    try check(task.completed.isEmpty, "OS task ended before its Go runtime")
    runtime.closing!(nil)
    try check(task.completed == [true] && session.state == .stopped, "explicit stop did not retire both owners")
    session.start(openBrowser: false)
    let replacementTask = scheduler.deliver(scheduler.submitted.last!.identifier)
    let replacement = PiikRuntime.instances.last!
    runtime.ready("http://127.0.0.1:1/stale")
    replacement.ready("http://127.0.0.1:8787/client")
    originalOpen(false); flushMain()
    try check(session.state == .running && UIApplication.shared.opened.count == 1, "retired browser/startup callback changed the replacement")
    var prepared = false
    session.preparationFinished = { prepared = true }
    replacement.prepared()
    try check(prepared && UIApplication.shared.opened.count == 1, "capture completion reopened a browser tab")
    replacementTask.expirationHandler!(); flushMain()
    try check(session.state == .stopping && replacement.closing != nil && replacementTask.completed.isEmpty, "expiry did not join runtime retirement")
    replacement.closing!(nil)
    try check(replacementTask.completed == [false], "expired session reported success")
    if case .failed = session.state {} else { throw CheckFailure("expiry lost its failure state") }
    scheduler.rejected = true
    let count = PiikRuntime.instances.count
    session.start(openBrowser: true)
    try check(PiikRuntime.instances.count == count, "rejected admission started a runtime")
    scheduler.rejected = false
    session.start(openBrowser: false)
    let startupTask = scheduler.deliver(scheduler.submitted.last!.identifier)
    let startup = PiikRuntime.instances.last!
    session.stop()
    startup.ready("http://127.0.0.1:8787/client")
    try check(session.state == .stopping && startupTask.completed.isEmpty, "late readiness escaped Stop during startup")
    startup.closing!(nil)
    try check(startupTask.completed == [true] && session.state == .stopped, "startup cancellation did not retire")
    print("PASS production CompanionSession: admission, stale callbacks, browser readiness, cancellation, expiry, stop/start retirement")
}

do { try run() }
catch { fputs("FAIL companion lifecycle: \(error)\n", stderr); exit(1) }
