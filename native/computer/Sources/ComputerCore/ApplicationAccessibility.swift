import AppKit

extension Computer {
    func prepareAccessibility(_ window: WindowIdentity) throws {
        if let launched = window.launched, accessibilityProviders[window.pid] == launched { return }
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        // Chromium lazily builds its web AX tree when an assistive client opts
        // in. These provider flags request exposure, not application focus or
        // business input; unsupported flags leave ordinary AppKit AX intact.
        var error = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if error == .attributeUnsupported || error == .notImplemented {
            error = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        if error == .attributeUnsupported || error == .notImplemented { return }
        guard error == .success else {
            throw ComputerFailure(error == .apiDisabled ? "permission_required" : "accessibility_unavailable",
                "The application could not enable its accessibility provider (\(error.rawValue)); no input was sent.")
        }
        if let launched = window.launched { accessibilityProviders[window.pid] = launched }
    }
}
