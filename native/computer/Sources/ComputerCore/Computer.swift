import AppKit
import ApplicationServices
import Darwin

@MainActor public final class Computer {
    var snapshot: Snapshot?
    var lastObservation: Snapshot?
    var isolation: IsolationSession?
    var hovered: HoveredAlternate?

    public init() {}

    public func reset(releaseDisplay: Bool = false) async throws {
        snapshot = nil; lastObservation = nil
        try await isolation?.reveal()
        if let hovered {
            let resource = try await NativeResources.acquire(["app-\(hovered.window.pid)"])
            defer { withExtendedLifetime(resource) {} }
            try resource.advanceRevision(hovered.window.pid)
            _ = try updateHover(nil, reveal: false)
        }
        // Keep an empty display lease for this MCP connection. Rapid turns must
        // not repeatedly tear down/recreate the host's display arrangement.
        if releaseDisplay { isolation = nil }
    }

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
            let point = CGEvent(source: nil)?.location
            return try result(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "process_id": getpid(),
                "frontmost_pid": NSWorkspace.shared.frontmostApplication.map { $0.processIdentifier as Any } ?? NSNull(),
                "pointer": point.map { ["x": $0.x, "y": $0.y] as Any } ?? NSNull()])
        case "list":
            return try result(["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
                ["pid": $0.processIdentifier, "name": $0.localizedName ?? "", "bundle_id": $0.bundleIdentifier ?? "", "app_path": $0.bundleURL?.path ?? "",
                    "launch_time": $0.launchDate.map { $0.timeIntervalSince1970 as Any } ?? NSNull(), "hidden": $0.isHidden, "active": $0.isActive] as [String: Any]
            }, "windows": try windows(includeHidden: args["include_hidden"] as? Bool == true).map { window in
                ["pid": window.pid, "window_id": window.windowID, "frame": frameData(window.frame), "launch_time": window.launched.map { $0.timeIntervalSince1970 as Any } ?? NSNull()] as [String: Any]
            }, "displays": try displays().map { ["display_id": $0.id, "frame": frameData($0.frame), "main": $0.id == CGMainDisplayID()] as [String: Any] }])
        case "launch":
            return try await launch(args)
        case "observe":
            return try await observe(args)
        case "query": return try query(args)
        case "window": return try await manageWindow(args)
        case "isolation": return try await isolate(args)
        case "sequence": return try await sequence(args)
        case "wait_for", "wait_for_change": return try await wait(args, change: action == "wait_for_change")
        case "click", "press", "type", "key", "keys", "scroll", "drag", "paste", "set_value", "select_text", "perform_action", "hover", "invoke_menu":
            if args["after"] != nil, ObservationMode(rawValue: args["after"] as? String ?? "") == nil {
                throw ComputerFailure("invalid_arguments", "after must be ax, vision, or both.")
            }
            if args["expect"] != nil { _ = try AXExpectation(args["expect"]); _ = try waitTimeout(args) }
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

    func windows(includeHidden: Bool = false) throws -> [WindowIdentity] {
        guard let rows = CGWindowListCopyWindowInfo(includeHidden ? .optionAll : .optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
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
