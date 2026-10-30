import AppKit
import ApplicationServices

@MainActor func requestApplicationActivation(_ app: NSRunningApplication) -> AXError {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(application, kAXFrontmostAttribute as CFString, &settable)
    if error == .success, settable.boolValue {
        // AppKit activation is cooperative and may be ignored even when its
        // request returns true. Explicit foreground delivery can use granted AX.
        return AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    if error == .attributeUnsupported || error == .notImplemented || (error == .success && !settable.boolValue) {
        return app.activate() ? .success : .failure
    }
    return error
}

extension Computer {
    func manageWindow(_ args: [String: Any]) async throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw ComputerFailure("permission_required", "Enable Accessibility for window management.") }
        guard let pid = args["pid"] as? Int32, let launch = args["launch_time"] as? Double,
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              processLaunchDate(app.processIdentifier)?.timeIntervalSince1970 == launch,
              let action = args["window_action"] as? String,
              ["activate", "hide", "show", "raise", "minimize", "restore", "move", "resize", "close"].contains(action) else {
            throw ComputerFailure("invalid_arguments", "Window management requires pid, launch_time from list, and a supported window_action.")
        }
        guard isolation?.owns(pid) != true else { throw ComputerFailure("app_concealed", "Reveal the isolated app before window management.") }
        let resource = try await NativeResources.acquire(["app-\(pid)"] + (action == "activate" ? ["foreground"] : []))
        defer { withExtendedLifetime(resource) {} }
        guard !app.isTerminated, processLaunchDate(app.processIdentifier)?.timeIntervalSince1970 == launch else { throw ComputerFailure("stale_snapshot", "The target application exited.") }
        let window: AXUIElement?
        if ["activate", "hide", "show"].contains(action) { window = nil }
        else {
            guard let id = args["window_id"] as? UInt32,
                  let identity = try windows(includeHidden: true).first(where: { $0.pid == pid && $0.windowID == id }),
                  let element = windowElement(identity) else {
                throw ComputerFailure("window_not_found", "The exact window is no longer accessible; list with include_hidden=true for minimized windows.")
            }
            window = element
        }
        var change: (String, CFTypeRef)?
        switch action {
        case "minimize", "restore": change = (kAXMinimizedAttribute, action == "minimize" ? kCFBooleanTrue : kCFBooleanFalse)
        case "move":
            guard let x = args["x"] as? Double, let y = args["y"] as? Double, x.isFinite, y.isFinite else { throw ComputerFailure("invalid_arguments", "move requires finite global screen x/y.") }
            var point = CGPoint(x: x, y: y)
            guard let encoded = AXValueCreate(.cgPoint, &point) else { throw ComputerFailure("native_error", "Could not encode window position.") }
            change = (kAXPositionAttribute, encoded)
        case "resize":
            guard let width = args["width"] as? Double, let height = args["height"] as? Double,
                  width.isFinite, height.isFinite, width > 0, height > 0 else { throw ComputerFailure("invalid_arguments", "resize requires positive finite width/height.") }
            var size = CGSize(width: width, height: height)
            guard let encoded = AXValueCreate(.cgSize, &size) else { throw ComputerFailure("native_error", "Could not encode window size.") }
            change = (kAXSizeAttribute, encoded)
        default: break
        }
        snapshot = nil
        try resource.advanceRevision(pid)
        let error: AXError
        if let change, let window { error = AXUIElementSetAttributeValue(window, change.0 as CFString, change.1) }
        else {
            switch action {
            case "activate":
                error = requestApplicationActivation(app)
            case "hide":
                error = app.isHidden ? .success : AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXHiddenAttribute as CFString, kCFBooleanTrue)
            case "show":
                error = !app.isHidden ? .success : AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXHiddenAttribute as CFString, kCFBooleanFalse)
            case "raise": error = AXUIElementPerformAction(window!, kAXRaiseAction as CFString)
            case "close":
                guard let button = attribute(window!, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID() else {
                    throw ComputerFailure("action_refused", "The window has no accessible close button.")
                }
                error = AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
            default: preconditionFailure("Window action was validated")
            }
        }
        guard error == .success else { throw ComputerFailure("action_refused", "Window operation was refused (\(error.rawValue)); observe before another action.") }
        return try result(["effect": "unverified", "pid": pid, "launch_time": launch, "window_action": action])
    }
}
