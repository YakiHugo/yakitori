import AppKit
import ApplicationServices

extension Computer {
    func input(_ action: String, _ args: [String: Any]) async throws -> [String: Any] {
        try validateInput(action, args)
        guard AXIsProcessTrusted() else {
            throw ComputerFailure("permission_required", "Enable Accessibility for Yakitori Computer in System Settings.")
        }
        guard let ticket = snapshot else {
            throw ComputerFailure("stale_snapshot", "Observe the target window before each input action.")
        }
        try ticket.validate(id: args["snapshot_id"] as? String, windows: windows(), displays: displays())
        let target = try ticket.target(args)
        let window = target.window, element = target.element
        var point = target.point
        if action == "hover", point == nil, let element, let frame = elementFrame(element),
           let window, !target.applicationUI, window.frame.contains(frame) {
            point = CGPoint(x: frame.midX, y: frame.midY)
        }
        // WindowServer can briefly retain a closed window while AppKit still
        // accepts AXPress on its retained controls. Confirm it is still exposed
        // by the application's current AX window list before using an element.
        if element != nil, !target.applicationUI, let window, windowElement(window) == nil {
            throw ComputerFailure("stale_snapshot", "The element's window is no longer accessible; observe again.")
        }
        let foreground = args["delivery"] as? String == "foreground"
        if let delivery = args["delivery"], !["foreground", "background"].contains(delivery as? String ?? "") {
            throw ComputerFailure("invalid_arguments", "delivery must be background or foreground.")
        }
        if ticket.scope == .screen && !foreground && !["press", "perform_action", "set_value", "select_text"].contains(action) {
            throw ComputerFailure("foreground_required", "Screen input requires delivery=foreground; use window/app scope for background input.")
        }
        let duration = try inputDuration(args)
        let modifiers = try inputModifiers(args["modifiers"])
        let chord = action == "key" || (["click", "drag"].contains(action) && args["key"] != nil) ? try keyChord(args["key"] as? String) : nil
        var chords: [(CGKeyCode?, CGEventFlags)] = []
        if action == "keys" {
            guard let keys = args["keys"] as? [String], !keys.isEmpty, keys.count <= 64 else {
                throw ComputerFailure("invalid_arguments", "keys requires 1...64 chords within the native sequence safety boundary.")
            }
            chords = try keys.map { try keyChord($0) }
        }
        let paste = action == "paste" ? try pasteboardItem(args) : nil
        let text = args["text"] as? String
        if action == "type", text == nil { throw ComputerFailure("invalid_arguments", "type requires text.") }
        if action == "type", args["replace"] as? Bool == true, element == nil {
            throw ComputerFailure("invalid_arguments", "Replacement requires a target element so its complete selection can be confirmed before typing.")
        }
        let elementAction = ["press", "perform_action", "set_value", "select_text"].contains(action)
        let axAction = elementAction || action == "invoke_menu"
        if elementAction, element == nil { throw ComputerFailure("invalid_arguments", "This AX action requires an element.") }
        let buttonName = args["button"] as? String ?? "left"
        guard ["left", "right", "middle"].contains(buttonName) else { throw ComputerFailure("invalid_arguments", "Unknown mouse button.") }
        let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
        let downType: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let upType: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        let draggedType: CGEventType = button == .right ? .rightMouseDragged : button == .center ? .otherMouseDragged : .leftMouseDragged
        let clickCount = args["click_count"] as? Int ?? 1
        guard (1...3).contains(clickCount) else { throw ComputerFailure("invalid_arguments", "click_count must be 1, 2 or 3.") }
        if ["click", "scroll", "drag", "hover"].contains(action), point == nil {
            throw ComputerFailure("invalid_arguments", "This action requires screenshot coordinates x and y.")
        }
        let end = action == "drag" ? try ticket.point(x: args["to_x"] as? Double ?? -1, y: args["to_y"] as? Double ?? -1, space: args["coordinate_space"] as? String ?? "screenshot") : nil
        let dx = args["dx"] as? Int32 ?? 0
        let dy = args["dy"] as? Int32 ?? 0
        if action == "scroll", abs(Int64(dx)) > 2000 || abs(Int64(dy)) > 2000 {
            throw ComputerFailure("invalid_arguments", "Scroll deltas must be within 2000 pixels per action; observe between larger movements.")
        }
        if action == "invoke_menu", window == nil || ticket.scope == .screen {
            throw ComputerFailure("invalid_arguments", "invoke_menu requires an observed application window.")
        }
        if foreground, let window, isolation?.owns(window.pid) == true {
            throw ComputerFailure("app_concealed", "Reveal the isolated app and observe again before foreground input.")
        }
        let keyboard = ["type", "key", "keys", "paste"].contains(action)
        let screenKeyboardPID = foreground && ticket.scope == .screen && element == nil && keyboard
            ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil
        let resourcePID = window?.pid ?? screenKeyboardPID
        let resourcePIDs = Set([resourcePID, hovered?.window.pid].compactMap { $0 })
        let appResources = resourcePIDs.filter { isolation?.owns($0) != true }.map { "app-\($0)" }
        let resources = try await NativeResources.acquire(appResources + (foreground ? ["foreground"] : []))
        defer { withExtendedLifetime(resources) {} }
        try ticket.validate(id: ticket.id, windows: windows(), displays: displays())
        if let screenKeyboardPID, NSWorkspace.shared.frontmostApplication?.processIdentifier != screenKeyboardPID {
            throw ComputerFailure("focus_changed", "The screen keyboard target changed while waiting for input ownership.")
        }
        for resourcePID in resourcePIDs {
            if isolation?.owns(resourcePID) == true { try isolation?.advanceRevision(resourcePID) }
            else { try resources.advanceRevision(resourcePID) }
        }
        // Consume before any action, including focus. A failed delivery must
        // never invite replay against the same stale element or screenshot.
        snapshot = nil
        let alternateHover = try updateHover(target, reveal: action == "hover")
        var backgroundRelease: CGEvent?
        defer {
            if let backgroundRelease, let window,
               NSRunningApplication(processIdentifier: window.pid)?.launchDate == window.launched,
               NSWorkspace.shared.frontmostApplication?.processIdentifier != window.pid {
                backgroundRelease.postToPid(window.pid)
            }
        }
        if !foreground, !axAction, !alternateHover, let window,
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
        var evidence: [String: Any] = [:]
        if action == "hover", alternateHover {
            evidence["hover_route"] = "accessibility"
        } else if action == "invoke_menu" {
            guard let window, ticket.scope != .screen else { throw ComputerFailure("invalid_arguments", "invoke_menu requires an observed application window.") }
            evidence = try await invokeMenu(menuPath(args["path"]), window: window)
        } else if axAction, let element {
            evidence = try accessibilityInput(action, args: args, element: element)
        } else {
            if ["type", "key", "keys", "paste"].contains(action) {
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
            source?.localEventsSuppressionInterval = 0
            func checkpoint() throws {
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
                    if ticket.scope != .screen || ["type", "key", "keys", "paste"].contains(action) {
                        guard currentWindows.first(where: { $0.pid == foregroundPID })?.windowID == foregroundWindowID else {
                            throw ComputerFailure("focus_changed", "Foreground input stopped because another window became active.")
                        }
                    }
                }

            }
            func post(_ event: CGEvent) throws {
                try checkpoint()
                if ["type", "key", "keys", "paste"].contains(action), let element, let window {
                    let app = AXUIElementCreateApplication(window.pid)
                    guard let focused = attribute(app, kAXFocusedUIElementAttribute), CFEqual(focused, element) else {
                        throw ComputerFailure("focus_changed", "Keyboard input stopped because the addressed element lost focus.")
                    }
                }
                deliver(event, window: window, foreground: foreground)
            }
            func mouse(_ type: CGEventType, _ point: CGPoint) throws -> CGEvent {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
                    throw ComputerFailure("input_failed", "macOS could not create a mouse event.")
                }
                event.flags = modifiers.union(chord?.1 ?? [])
                if foreground { return event }
                guard let window else { throw ComputerFailure("window_not_found", "Background input needs an observed window.") }
                return try windowPointerEvent(event, window: window)
            }
            func sendKey(_ code: CGKeyCode?, flags: CGEventFlags) async throws {
                try await withHeldChord(code, flags: flags.union(modifiers), duration: duration, source: source, post: post,
                    release: { deliver($0, window: window, foreground: foreground) }, checkpoint: checkpoint) {}
            }
            try await withHeldChord(["click", "drag"].contains(action) ? chord?.0 : nil,
                flags: ["click", "scroll", "drag"].contains(action) ? modifiers.union(chord?.1 ?? []) : [],
                source: source, post: post, release: { deliver($0, window: window, foreground: foreground) }, checkpoint: checkpoint) {
                if let point, action == "hover" {
                    if !alternateHover { try post(mouse(.mouseMoved, point)) }
                    evidence["hover_route"] = alternateHover ? "accessibility" : "pointer"
                } else if let point, action == "click" {
                    for count in 1...clickCount {
                        let down = try mouse(downType, point)
                        let up = try mouse(upType, point)
                        down.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                        up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                        try post(down)
                        do {
                            try await holdInput(duration, checkpoint: checkpoint)
                        } catch {
                            deliver(up, window: window, foreground: foreground)
                            throw error
                        }
                        deliver(up, window: window, foreground: foreground)
                        if count < clickCount { try await Task.sleep(nanoseconds: 30_000_000) }
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
                        try await Task.sleep(nanoseconds: UInt64(max(0.2, duration) * 1_000_000_000 / 20))
                    }
                } else if action == "scroll", let point {
                    guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                        throw ComputerFailure("input_failed", "macOS could not create a scroll event.")
                    }
                    event.location = point
                    event.flags = modifiers
                    if foreground { try post(event) }
                    else if let window { try post(windowPointerEvent(event, window: window)) }
                } else if let paste {
                    try await withPasteContent(paste) { try await sendKey(9, flags: .maskCommand) }
                } else if let chord {
                    try await sendKey(chord.0, flags: chord.1)
                } else if action == "keys" {
                    for chord in chords { try await sendKey(chord.0, flags: chord.1) }
                } else if let text {
                    if args["replace"] as? Bool == true, let element {
                        // Background apps can ignore CMD+A while accepting text.
                        // Confirm selection directly instead of silently appending
                        // replacement text when a shortcut was not handled.
                        guard let value = attribute(element, kAXValueAttribute) as? String else {
                            throw ComputerFailure("selection_unconfirmed", "The target does not expose text for a confirmed replacement; no replacement text was sent.")
                        }
                        try confirmSelection(CFRange(location: 0, length: value.utf16.count), element: element)
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
                        try post(down)
                        deliver(up, window: window, foreground: foreground)
                        try await Task.sleep(nanoseconds: 2_000_000)
                    }
                }
            }
        }
        // Delivery/AX readback is not proof that the application committed a
        // business operation. Return that uncertainty rather than a fake success.
        evidence.merge(["effect": "unverified", "delivery": axAction || alternateHover ? "accessibility" : foreground ? "foreground" : "background",
            "message": "Observe the application result before continuing or retrying."]) { _, value in value }
        return try await completeInput(evidence, args: args, ticket: ticket)
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
