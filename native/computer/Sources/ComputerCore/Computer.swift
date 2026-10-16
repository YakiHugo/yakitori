import AppKit
import ApplicationServices
import ScreenCaptureKit
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
                ["pid": $0.processIdentifier, "name": $0.localizedName ?? "", "bundle_id": $0.bundleIdentifier ?? ""] as [String: Any]
            }, "windows": try windows().map { window in
                ["pid": window.pid, "window_id": window.windowID, "frame": NSStringFromRect(window.frame)]
            }])
        case "launch":
            guard let bundleID = args["bundle_id"] as? String,
                  let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
                throw ComputerFailure("app_not_found", "Provide an installed application's bundle_id.")
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false
            let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            return try result(["pid": app.processIdentifier])
        case "observe":
            return try await observe(args)
        case "click", "press", "type", "key", "scroll", "drag":
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
                  row[kCGWindowLayer as String] as? Int == 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.width > 1, frame.height > 1 else { return nil }
            return WindowIdentity(pid: pid, launched: NSRunningApplication(processIdentifier: pid)?.launchDate, windowID: id, frame: frame)
        }
    }

    func observe(_ args: [String: Any]) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else {
            throw ComputerFailure("permission_required", "Enable Screen Recording for Yakitori Computer in System Settings, then reconnect.")
        }
        guard let pid = args["pid"] as? Int32, let id = args["window_id"] as? UInt32,
              let identity = try windows().first(where: { $0.pid == pid && $0.windowID == id }) else {
            throw ComputerFailure("window_not_found", "List windows and provide an exact pid and window_id on the current desktop.")
        }
        snapshot = nil
        let shareable: SCShareableContent = try await nativeRequest { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
                if let error { done(.failure(error)) }
                else if let content { done(.success(content)) }
                else { done(.failure(ComputerFailure("capture_failed", "macOS returned no window content."))) }
            }
        }
        try Task.checkCancellation()
        guard let window = shareable.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid }) else {
            throw ComputerFailure("window_not_found", "The requested window is no longer capturable.")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        // A worst-case RGBA PNG at 1024² plus the bounded AX tree stays below
        // the host MCP framing boundary (8 MiB), including base64 overhead.
        let scale = min(1, 1024 / max(window.frame.width, window.frame.height))
        configuration.width = max(1, Int(window.frame.width * scale))
        configuration.height = max(1, Int(window.frame.height * scale))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let image: CGImage = try await nativeRequest { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                if let error { done(.failure(error)) }
                else if let image { done(.success(image)) }
                else { done(.failure(ComputerFailure("capture_failed", "macOS returned no screenshot."))) }
            }
        }
        try Task.checkCancellation()
        guard let current = try windows().first(where: { $0.pid == pid && $0.windowID == id }), current == identity,
              window.frame == identity.frame else {
            throw ComputerFailure("stale_snapshot", "The window moved during capture; observe it again.")
        }
        let tree = AXIsProcessTrusted() ? accessibilityTree(windowElement(identity)) : (rows: [], elements: [], truncated: false)
        let next = Snapshot(window: identity, imageWidth: image.width, imageHeight: image.height, elements: tree.elements)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ComputerFailure("capture_failed", "macOS did not encode the screenshot.")
        }
        snapshot = next
        return try result([
            "snapshot_id": next.id, "pid": pid, "window_id": id,
            "image_width": image.width, "image_height": image.height,
            "elements": tree.rows, "tree_truncated": tree.truncated,
            "accessibility": AXIsProcessTrusted(),
        ], image: png)
    }
}
