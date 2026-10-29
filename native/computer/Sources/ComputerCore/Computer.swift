import AppKit
import ApplicationServices
import Darwin

@MainActor public final class Computer {
    var snapshot: Snapshot?

    public init() {}

    public func reset() { snapshot = nil }

    public func execute(_ args: [String: Any]) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard let action = args["action"] as? String else {
            throw ComputerFailure("invalid_arguments", "An action is required.")
        }
        switch action {
        case "status", "permissions":
            if action == "permissions" {
                AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                CGRequestScreenCaptureAccess()
            }
            return try result(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "process_id": getpid()])
        case "list":
            return try result(["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
                ["pid": $0.processIdentifier, "name": $0.localizedName ?? "", "bundle_id": $0.bundleIdentifier ?? "", "app_path": $0.bundleURL?.path ?? ""] as [String: Any]
            }, "windows": try windows().map { window in
                ["pid": window.pid, "window_id": window.windowID, "frame": frameData(window.frame)]
            }, "displays": try displays().map { ["display_id": $0.id, "frame": frameData($0.frame), "main": $0.id == CGMainDisplayID()] as [String: Any] }])
        case "launch":
            return try await launch(args)
        case "observe":
            return try await observe(args)
        case "query_snapshot":
            return try querySnapshot(args)
        case "wait_for", "wait_for_change":
            return try await waitForObservation(action, args)
        case "click", "press", "type", "key", "scroll", "drag", "set_value", "select_text", "perform_action":
            return try await input(action, args)
        default:
            throw ComputerFailure("invalid_arguments", "Unknown computer action: \(action).")
        }
    }

    func result(_ data: [String: Any], image: Data? = nil) throws -> [String: Any] {
        let text = String(decoding: try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), as: UTF8.self)
        var content: [[String: Any]] = [["type": "text", "text": text]]
        if let image { content.append(["type": "image", "mimeType": "image/png", "data": image.base64EncodedString()]) }
        return ["content": content, "structuredContent": data]
    }

    func windows() throws -> [WindowIdentity] {
        guard let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            throw ComputerFailure("window_list_failed", "macOS could not list windows.")
        }
        return rows.compactMap { row in
            guard let pid = row[kCGWindowOwnerPID as String] as? Int32,
                  let id = row[kCGWindowNumber as String] as? UInt32,
                  let layer = row[kCGWindowLayer as String] as? Int, layer >= 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.width > 1, frame.height > 1 else { return nil }
            return WindowIdentity(pid: pid, launched: NSRunningApplication(processIdentifier: pid)?.launchDate, windowID: id, frame: frame, layer: layer)
        }
    }
}
