import AppKit
import ApplicationServices

extension Computer {
    func input(_ action: String, _ args: [String: Any]) async throws -> [String: Any] {
        guard AXIsProcessTrusted() else {
            throw ComputerFailure("permission_required", "Enable Accessibility for Yakitori Computer in System Settings.")
        }
        guard let ticket = snapshot else {
            throw ComputerFailure("stale_snapshot", "Observe the target window before each input action.")
        }
        try ticket.validate(id: args["snapshot_id"] as? String, windows: windows(), displays: displays())
        let target = try ticket.target(args)
        let window = target.window, element = target.element, point = target.point
        // WindowServer can briefly retain a closed window while AppKit still
        // accepts AXPress on its retained controls. Confirm it is still exposed
        // by the application's current AX window list before using an element.
        if element != nil, let window, windowElement(window) == nil {
            throw ComputerFailure("stale_snapshot", "The element's window is no longer accessible; observe again.")
        }
        let foreground = args["delivery"] as? String == "foreground"
        if let delivery = args["delivery"], !["foreground", "background"].contains(delivery as? String ?? "") {
            throw ComputerFailure("invalid_arguments", "delivery must be background or foreground.")
        }
        if ticket.scope == .screen && !foreground && action != "press" {
            throw ComputerFailure("foreground_required", "Screen input requires delivery=foreground; use window/app scope for background input.")
        }
        let chord = action == "key" ? try keyChord(args["key"] as? String) : nil
        let text = args["text"] as? String
        if action == "type", text == nil { throw ComputerFailure("invalid_arguments", "type requires text.") }
        if action == "type", args["replace"] as? Bool == true, element == nil {
            throw ComputerFailure("invalid_arguments", "Replacement requires a target element so its complete selection can be confirmed before typing.")
        }
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
        var backgroundRelease: CGEvent?
        defer {
            if let backgroundRelease, let window,
               NSRunningApplication(processIdentifier: window.pid)?.launchDate == window.launched,
               NSWorkspace.shared.frontmostApplication?.processIdentifier != window.pid {
                backgroundRelease.postToPid(window.pid)
            }
        }
        if !foreground, action != "press", let window,
           NSWorkspace.shared.frontmostApplication?.processIdentifier != window.pid {
            // Directed CGEvents bypass WindowServer activation. AppKit otherwise
            // treats a background click as an inactive-window first click. Scope
            // its local activation to this action; never suppress real user focus
            // events or activate the app on the shared desktop automatically.
            let events = try [NSEvent.EventSubtype.applicationActivated, .applicationDeactivated].map { subtype -> CGEvent in
                guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window.windowID), context: nil,
                    subtype: subtype.rawValue, data1: 0, data2: 0)?.cgEvent else {
                    throw ComputerFailure("input_failed", "macOS could not prepare directed application focus.")
                }
                return event
            }
            backgroundRelease = events[1]
            events[0].postToPid(window.pid)
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        if foreground, ticket.scope != .screen || element != nil, let window {
            guard let app = NSRunningApplication(processIdentifier: window.pid) else {
                throw ComputerFailure("window_not_found", "The target application exited.")
            }
            app.activate()
            if let axWindow = windowElement(window) { AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString) }
            let axApplication = AXUIElementCreateApplication(window.pid)
            // Bound the focus transition, rather than assuming every app has
            // activated after a fixed delay. This is a local OS-wait boundary.
            let deadline = ProcessInfo.processInfo.systemUptime + 1
            while true {
                try Task.checkCancellation()
                let current = try windows()
                guard current.contains(window) else {
                    throw ComputerFailure("stale_snapshot", "The target window changed while activating; observe again.")
                }
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == window.pid,
                   current.first(where: { $0.pid == window.pid })?.windowID == window.windowID,
                   current.first(where: { $0.layer == window.layer })?.windowID == window.windowID,
                   attribute(axApplication, kAXFrontmostAttribute) as? Bool == true { break }
                guard ProcessInfo.processInfo.systemUptime < deadline else {
                    throw ComputerFailure("focus_unconfirmed", "The requested window did not become frontmost; no input was sent.")
                }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
        }
        let foregroundPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let foregroundWindowID = ticket.scope != .screen || element != nil
            ? window?.windowID : try windows().first(where: { $0.pid == foregroundPID })?.windowID
        var screenTargetFocused = false
        if action == "press", let element {
            let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
            guard error == .success else { throw ComputerFailure("action_refused", "AXPress failed (\(error.rawValue)); observe before choosing another input method.") }
        } else {
            if action == "type" || action == "key" {
                if let element {
                    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    guard let window else { throw ComputerFailure("invalid_element", "The element has no target window.") }
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
                let currentWindows = try windows()
                if let window, !currentWindows.contains(window) {
                    throw ComputerFailure("stale_snapshot", "The target moved or exited during input; observe again.")
                }
                if let display = ticket.display, !(try displays().contains(display)) {
                    throw ComputerFailure("stale_snapshot", "The display changed during input; observe again.")
                }
                if foreground {
                    // A screen click may legitimately activate its destination;
                    // keyboard/drag input must still stop if focus is taken away.
                    let expectedPID = ticket.scope == .screen && ["click", "drag"].contains(action)
                        ? window?.pid ?? foregroundPID : foregroundPID
                    let currentPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
                    if currentPID == expectedPID { screenTargetFocused = true }
                    guard currentPID == expectedPID || (ticket.scope == .screen && !screenTargetFocused && currentPID == foregroundPID) else {
                        throw ComputerFailure("focus_changed", "Foreground input stopped because another app became active.")
                    }
                    if ticket.scope != .screen || action == "type" || action == "key" {
                        guard currentWindows.first(where: { $0.pid == foregroundPID })?.windowID == foregroundWindowID else {
                            throw ComputerFailure("focus_changed", "Foreground input stopped because another window became active.")
                        }
                    }
                }
                deliver(event, window: window, foreground: foreground)
            }
            func mouse(_ type: CGEventType, _ point: CGPoint) throws -> CGEvent {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
                    throw ComputerFailure("input_failed", "macOS could not create a mouse event.")
                }
                if foreground { return event }
                guard let window else { throw ComputerFailure("window_not_found", "Background input needs an observed window.") }
                return try windowPointerEvent(event, window: window)
            }
            func sendKey(_ code: CGKeyCode, flags: CGEventFlags) async throws {
                var releases: [CGEvent] = []
                defer {
                    // Release every key actually pressed, even if cancellation
                    // or a focus change stops the chord halfway through.
                    for event in releases.reversed() {
                        event.timestamp = DispatchTime.now().uptimeNanoseconds
                        deliver(event, window: window, foreground: foreground)
                    }
                }
                let modifiers: [(CGKeyCode, CGEventFlags)] = [(55, .maskCommand), (56, .maskShift), (58, .maskAlternate), (59, .maskControl)]
                var held: CGEventFlags = []
                for (key, modifier) in modifiers.filter({ flags.contains($0.1) }) + [(code, CGEventFlags(rawValue: 0))] {
                    guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
                          let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
                        throw ComputerFailure("input_failed", "macOS could not create a keyboard event.")
                    }
                    let previous = held
                    held.formUnion(modifier)
                    down.flags = held
                    up.flags = modifier.isEmpty ? held : previous
                    if !modifier.isEmpty { down.type = .flagsChanged; up.type = .flagsChanged }
                    try post(down)
                    releases.append(up)
                    // Keep modifier and key-down delivery distinct while the
                    // same release path handles completion and interruption.
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
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
                var up = try mouse(upType, point)
                try post(mouse(downType, point))
                // Always release the button, including cancellation and failure.
                defer { deliver(up, window: window, foreground: foreground) }
                for step in 1...20 {
                    let progress = Double(step) / 20
                    let next = CGPoint(x: point.x + (end.x - point.x) * progress, y: point.y + (end.y - point.y) * progress)
                    let release = try mouse(upType, next)
                    try post(mouse(draggedType, next))
                    up = release
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
            } else if action == "scroll", let point {
                guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                    throw ComputerFailure("input_failed", "macOS could not create a scroll event.")
                }
                event.location = point
                if foreground { try post(event) }
                else if let window { try post(windowPointerEvent(event, window: window)) }
            } else if let chord {
                try await sendKey(chord.0, flags: chord.1)
            } else if let text {
                if args["replace"] as? Bool == true, let element {
                    // Background apps can ignore CMD+A while accepting text.
                    // Confirm selection directly instead of silently appending
                    // replacement text when a shortcut was not handled.
                    guard let value = attribute(element, kAXValueAttribute) as? String else {
                        throw ComputerFailure("selection_unconfirmed", "The target does not expose text for a confirmed replacement; no replacement text was sent.")
                    }
                    var range = CFRange(location: 0, length: value.utf16.count)
                    guard let selection = AXValueCreate(.cfRange, &range),
                          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success,
                          let readback = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(readback) == AXValueGetTypeID() else {
                        throw ComputerFailure("selection_unconfirmed", "The target did not confirm a complete text selection; no replacement text was sent.")
                    }
                    var confirmed = CFRange()
                    guard AXValueGetValue(readback as! AXValue, .cfRange, &confirmed), confirmed.location == 0, confirmed.length == range.length else {
                        throw ComputerFailure("selection_unconfirmed", "The target did not select all text; no replacement text was sent.")
                    }
                }
                for scalar in text.unicodeScalars {
                    try Task.checkCancellation()
                    let units = Array(String(scalar).utf16)
                    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                        throw ComputerFailure("input_failed", "macOS could not create a text event.")
                    }
                    down.flags = []
                    up.flags = []
                    units.withUnsafeBufferPointer { buffer in
                        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                    }
                    // A user/app can move focus while a long string is sent.
                    if let element {
                        guard let window else { throw ComputerFailure("invalid_element", "The element has no target window.") }
                        let app = AXUIElementCreateApplication(window.pid)
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

private func deliver(_ event: CGEvent, window: WindowIdentity?, foreground: Bool) {
    if let window {
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(window.pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowID))
    }
    if foreground { event.post(tap: .cghidEventTap) }
    else if let window { event.postToPid(window.pid) }
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
