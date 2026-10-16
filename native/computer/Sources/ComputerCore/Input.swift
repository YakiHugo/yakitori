import AppKit
import ApplicationServices

extension Computer {
    func input(_ action: String, _ args: [String: Any]) async throws -> [String: Any] {
        guard AXIsProcessTrusted() else {
            throw ComputerFailure("permission_required", "Enable Accessibility for Yakitori Computer in System Settings.")
        }
        guard let ticket = snapshot,
              let window = try windows().first(where: { $0.windowID == ticket.window.windowID }) else {
            throw ComputerFailure("stale_snapshot", "Observe the target window before each input action.")
        }
        try ticket.validate(id: args["snapshot_id"] as? String, window: window)
        let foreground = args["delivery"] as? String == "foreground"
        if let delivery = args["delivery"] as? String, !["foreground", "background"].contains(delivery) {
            throw ComputerFailure("invalid_arguments", "delivery must be background or foreground.")
        }
        let element: AXUIElement?
        if let index = args["element"] as? Int {
            guard ticket.elements.indices.contains(index) else {
                throw ComputerFailure("invalid_element", "The element is not in the latest snapshot.")
            }
            element = ticket.elements[index]
        } else { element = nil }
        let point: CGPoint?
        if let x = args["x"] as? Double, let y = args["y"] as? Double {
            point = try ticket.point(x: x, y: y)
        } else { point = nil }
        let chord = action == "key" ? try keyChord(args["key"] as? String) : nil
        let text = args["text"] as? String
        if action == "type", text == nil { throw ComputerFailure("invalid_arguments", "type requires text.") }
        if action == "press", element == nil { throw ComputerFailure("invalid_arguments", "press requires an element.") }
        let buttonName = args["button"] as? String ?? "left"
        guard ["left", "right", "middle"].contains(buttonName) else { throw ComputerFailure("invalid_arguments", "Unknown mouse button.") }
        let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
        let downType: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let upType: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        let draggedType: CGEventType = button == .right ? .rightMouseDragged : button == .center ? .otherMouseDragged : .leftMouseDragged
        let clickCount = args["click_count"] as? Int ?? 1
        guard (1...3).contains(clickCount) else { throw ComputerFailure("invalid_arguments", "click_count must be 1, 2 or 3.") }
        if ["click", "scroll", "drag"].contains(action), point == nil {
            throw ComputerFailure("invalid_arguments", "This action requires screenshot coordinates x and y.")
        }
        let end = action == "drag" ? try ticket.point(x: args["to_x"] as? Double ?? -1, y: args["to_y"] as? Double ?? -1) : nil
        let dx = args["dx"] as? Int32 ?? 0
        let dy = args["dy"] as? Int32 ?? 0
        if action == "scroll", abs(Int64(dx)) > 2000 || abs(Int64(dy)) > 2000 {
            throw ComputerFailure("invalid_arguments", "Scroll deltas must be within 2000 pixels per action; observe between larger movements.")
        }
        // Consume before any action, including focus. A failed delivery must
        // never invite replay against the same stale element or screenshot.
        snapshot = nil
        if foreground {
            guard let app = NSRunningApplication(processIdentifier: window.pid) else {
                throw ComputerFailure("window_not_found", "The target application exited.")
            }
            app.activate()
            if let axWindow = windowElement(window) { AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString) }
            try await Task.sleep(nanoseconds: 100_000_000)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == window.pid,
                  try windows().first?.windowID == window.windowID else {
                throw ComputerFailure("focus_unconfirmed", "The requested window did not become frontmost; no input was sent.")
            }
        }
        if action == "press", let element {
            let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
            guard error == .success else { throw ComputerFailure("action_refused", "AXPress failed (\(error.rawValue)); observe before choosing another input method.") }
        } else {
            if action == "type" || action == "key" {
                if let element {
                    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    let app = AXUIElementCreateApplication(window.pid)
                    guard let focused = attribute(app, kAXFocusedUIElementAttribute), CFEqual(focused, element) else {
                        throw ComputerFailure("focus_unconfirmed", "The target element did not acquire keyboard focus; no keys were sent.")
                    }
                } else if !foreground {
                    throw ComputerFailure("focus_unconfirmed", "Background keyboard input requires a target element. A canvas may require explicit foreground delivery.")
                }
            }
            let source = CGEventSource(stateID: .privateState)
            func post(_ event: CGEvent) throws {
                try Task.checkCancellation()
                guard try windows().contains(window) else {
                    throw ComputerFailure("stale_snapshot", "The target moved or exited during input; observe again.")
                }
                if foreground {
                    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == window.pid,
                          try windows().first?.windowID == window.windowID else {
                        throw ComputerFailure("focus_changed", "Foreground input stopped because another app became active.")
                    }
                }
                deliver(event, window: window, foreground: foreground)
            }
            func mouse(_ type: CGEventType, _ point: CGPoint) throws -> CGEvent {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
                    throw ComputerFailure("input_failed", "macOS could not create a mouse event.")
                }
                return event
            }
            if let point, action == "click" {
                for count in 1...clickCount {
                    let down = try mouse(downType, point)
                    let up = try mouse(upType, point)
                    down.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                    up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                    try post(down)
                    deliver(up, window: window, foreground: foreground)
                }
            } else if let point, let end {
                let up = try mouse(upType, point)
                try post(mouse(downType, point))
                // Always release the button, including cancellation and failure.
                defer { deliver(up, window: window, foreground: foreground) }
                for step in 1...20 {
                    let progress = Double(step) / 20
                    let next = CGPoint(x: point.x + (end.x - point.x) * progress, y: point.y + (end.y - point.y) * progress)
                    try post(mouse(draggedType, next))
                    up.location = next
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
            } else if action == "scroll", let point {
                guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                    throw ComputerFailure("input_failed", "macOS could not create a scroll event.")
                }
                event.location = point
                try post(event)
            } else if let chord {
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: chord.0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: chord.0, keyDown: false) else {
                    throw ComputerFailure("input_failed", "macOS could not create a key event.")
                }
                down.flags = chord.1
                up.flags = chord.1
                try post(down)
                deliver(up, window: window, foreground: foreground)
            } else if let text {
                if args["replace"] as? Bool == true {
                    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                        throw ComputerFailure("input_failed", "macOS could not create the select-all event.")
                    }
                    down.flags = .maskCommand
                    up.flags = .maskCommand
                    try post(down)
                    deliver(up, window: window, foreground: foreground)
                }
                for scalar in text.unicodeScalars {
                    try Task.checkCancellation()
                    let units = Array(String(scalar).utf16)
                    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                        throw ComputerFailure("input_failed", "macOS could not create a text event.")
                    }
                    units.withUnsafeBufferPointer { buffer in
                        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                    }
                    // A user/app can move focus while a long string is sent.
                    let app = AXUIElementCreateApplication(window.pid)
                    if let element {
                        guard let focused = attribute(app, kAXFocusedUIElementAttribute), CFEqual(focused, element) else {
                            throw ComputerFailure("focus_changed", "Typing stopped because the target element lost focus. Some text may already have arrived; observe before continuing.")
                        }
                    }
                    try post(down)
                    deliver(up, window: window, foreground: foreground)
                    try await Task.sleep(nanoseconds: 2_000_000)
                }
            }
        }
        // Delivery/AX readback is not proof that the application committed a
        // business operation. Return that uncertainty rather than a fake success.
        return try result(["effect": "unverified", "delivery": action == "press" ? "accessibility" : foreground ? "foreground" : "background", "message": "Observe the window to verify the application result before continuing or retrying."])
    }
}

private func deliver(_ event: CGEvent, window: WindowIdentity, foreground: Bool) {
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(window.pid))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowID))
    if foreground { event.post(tap: .cghidEventTap) }
    else { event.postToPid(window.pid) }
}

func keyChord(_ value: String?) throws -> (CGKeyCode, CGEventFlags) {
    guard let value else { throw ComputerFailure("invalid_arguments", "key requires a chord such as CMD+A or ENTER.") }
    var parts = value.uppercased().split(separator: "+").map(String.init)
    let keys: [String: CGKeyCode] = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35, "ENTER": 36, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "ESC": 53, "HOME": 115, "PAGEUP": 116, "DELETE": 117, "END": 119, "PAGEDOWN": 121, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126]
    guard let key = parts.popLast(), let code = keys[key] else { throw ComputerFailure("invalid_arguments", "Unsupported key chord.") }
    var flags: CGEventFlags = []
    for part in parts {
        switch part {
        case "CMD": flags.insert(.maskCommand)
        case "CTRL": flags.insert(.maskControl)
        case "ALT": flags.insert(.maskAlternate)
        case "SHIFT": flags.insert(.maskShift)
        default: throw ComputerFailure("invalid_arguments", "Unsupported key modifier: \(part).")
        }
    }
    return (code, flags)
}
