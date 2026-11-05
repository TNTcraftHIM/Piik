// SDK-only package fixture; never included in the distributed App.
import AppKit
import Carbon

@main
enum AppLifecycle {
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition {
            throw NSError(domain: "PiikMacAppLifecycle", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    static func report(_ app: NSRunningApplication, expected: String) throws {
        try require(app.processIdentifier > 0, "Owned PID was not observed before application exit")
        let executable = app.executableURL?.resolvingSymlinksInPath().path
        try require(executable == URL(fileURLWithPath: expected).resolvingSymlinksInPath().path,
                    "Application executable does not match the owned bundle")
        var facts: [String: Any] = ["pid": Int(app.processIdentifier),
                                   "executable": executable!, "launchDate": NSNull()]
        if let date = app.launchDate { facts["launchDate"] = date.timeIntervalSince1970 }
        let bytes = try JSONSerialization.data(withJSONObject: facts)
        FileHandle.standardOutput.write(bytes + Data([10]))
    }

    @MainActor
    static func main() async throws {
        let args = Array(CommandLine.arguments.dropFirst())
        try require(args.count >= 3, "Expected launch, inspect or quit and owned paths")
        if args[0] == "launch" {
            try require(args.count == 4, "Expected bundle, environment file and executable")
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2])))
            guard let environment = input as? [String: String] else {
                throw NSError(domain: "PiikMacAppLifecycle", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "Expected an isolated environment object"])
            }
            configuration.environment = environment
            let app = try await NSWorkspace.shared.openApplication(
                at: URL(fileURLWithPath: args[1]), configuration: configuration)
            try report(app, expected: args[3])
            return
        }
        try require(args.count == 3, "Expected PID and owned executable")
        guard let pid = Int32(args[1]), let app = NSRunningApplication(processIdentifier: pid) else {
            throw NSError(domain: "PiikMacAppLifecycle", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Owned application is not running"])
        }
        if args[0] == "inspect" {
            try report(app, expected: args[2])
            return
        }
        try require(args[0] == "quit", "Unknown lifecycle action")
        try require(app.executableURL?.resolvingSymlinksInPath().path ==
                    URL(fileURLWithPath: args[2]).resolvingSymlinksInPath().path,
                    "Quit target does not match the owned executable")
        let target = NSAppleEventDescriptor(processIdentifier: pid)
        let permission = AEDeterminePermissionToAutomateTarget(
            target.aeDesc, AEEventClass(kCoreEventClass), AEEventID(kAEQuitApplication), false)
        if permission == errAEEventWouldRequireUserConsent {
            let bytes = try JSONSerialization.data(withJSONObject: [
                "pid": Int(pid), "preflight": Int(permission), "quitSent": false,
                "reason": "user-consent-required"])
            FileHandle.standardOutput.write(bytes + Data([10]))
            return
        }
        try require(permission == noErr, "Quit automation preflight denied without prompting: \(permission)")
        let quit = NSAppleEventDescriptor(
            eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEQuitApplication),
            targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID),
            transactionID: AETransactionID(kAnyTransactionID))
        let reply = try quit.sendEvent(options: .waitForReply, timeout: 10)
        let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value ?? 0
        try require(error == 0, "Quit AppleEvent returned error \(error)")
        let bytes = try JSONSerialization.data(withJSONObject: [
            "pid": Int(pid), "preflight": Int(permission), "quitSent": true,
            "quitError": Int(error)])
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}
