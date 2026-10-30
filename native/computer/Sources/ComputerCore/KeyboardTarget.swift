import AppKit

func windowKeyboardEvent(_ event: CGEvent, window: WindowIdentity) throws -> CGEvent {
    guard [.keyDown, .keyUp, .flagsChanged].contains(event.type) else {
        throw ComputerFailure("input_failed", "Expected a keyboard event for window routing.")
    }
    var length = 0
    event.keyboardGetUnicodeString(maxStringLength: 0, actualStringLength: &length, unicodeString: nil)
    var units = [UniChar](repeating: 0, count: length)
    if length > 0 { units.withUnsafeMutableBufferPointer { event.keyboardGetUnicodeString(maxStringLength: $0.count, actualStringLength: &length, unicodeString: $0.baseAddress) } }
    let unicode = units.isEmpty ? nil : String(decoding: units, as: UTF16.self)
    guard let native = NSEvent(cgEvent: event),
          let routed = NSEvent.keyEvent(with: event.type == .keyUp ? .keyUp : .keyDown, location: .zero,
            modifierFlags: native.modifierFlags, timestamp: native.timestamp, windowNumber: Int(window.windowID), context: nil,
            characters: event.type == .flagsChanged ? "" : unicode ?? native.characters ?? "",
            charactersIgnoringModifiers: event.type == .flagsChanged ? "" : unicode ?? native.charactersIgnoringModifiers ?? "",
            isARepeat: false, keyCode: native.keyCode)?.cgEvent else {
        throw ComputerFailure("input_failed", "macOS could not encode the exact keyboard window.")
    }
    routed.type = event.type
    routed.flags = event.flags
    routed.timestamp = event.timestamp
    // The NSEvent bridge can lose supplementary-plane scalars (surrogate
    // pairs). Restore the original CGEvent UTF-16 payload after window encoding.
    if !units.isEmpty { units.withUnsafeBufferPointer { routed.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) } }
    return routed
}

func keyboardFocusMatches(_ element: AXUIElement, window: WindowIdentity, windowBound: Bool) -> Bool {
    let app = AXUIElementCreateApplication(window.pid)
    if let focused = elementAttribute(app, kAXFocusedUIElementAttribute) { return CFEqual(focused, element) }
    // WebKit can expose DOM focus while its inactive application's global AX
    // focus is absent. Accept that only with a proven native window identity
    // and keyboard events encoded for that exact window, never PID-only keys.
    guard windowBound, attribute(element, kAXFocusedAttribute) as? Bool == true,
          let owner = elementAttribute(element, kAXWindowAttribute), accessibilityWindowID(owner) == window.windowID else { return false }
    if let focusedWindow = elementAttribute(app, kAXFocusedWindowAttribute), accessibilityWindowID(focusedWindow) != window.windowID { return false }
    return true
}
