import AppKit

func prepareAccessibility(_ window: WindowIdentity, providers: inout [Int32: Date]) throws -> Bool {
    if let launched = window.launched, providers[window.pid] == launched { return false }
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    // Chromium lazily builds its web AX tree when an assistive client opts
    // in. These provider flags request exposure, not application focus or
    // business input; unsupported flags leave ordinary AppKit AX intact.
    var error = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    if error == .attributeUnsupported || error == .notImplemented {
        error = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
    if error == .attributeUnsupported || error == .notImplemented { return false }
    guard error == .success else {
        throw ComputerFailure(error == .apiDisabled ? "permission_required" : "accessibility_unavailable",
            "The application could not enable its accessibility provider (\(error.rawValue)); no input was sent.",
            evidence: ["ax_error": error.rawValue])
    }
    if let launched = window.launched { providers[window.pid] = launched }
    return true
}
