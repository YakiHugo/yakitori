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
        let supplementaryText = action == "type" && text?.unicodeScalars.contains(where: { $0.value > 0xffff }) == true
        // Foreground paste preserves supplementary characters across web
        // engines. Background native controls can handle Unicode while ignoring
        // paste, so retain their event route and verify risky scalar insertion.
        let unicodePaste = foreground && supplementaryText
            ? try pasteboardItem(["text": text ?? "", "format": "text"]) : nil
        if action == "type", args["replace"] as? Bool == true, element == nil {
            throw ComputerFailure("invalid_arguments", "Replacement requires a target element so its complete selection can be confirmed before typing.")
        }
        let elementAction = ["press", "perform_action", "set_value", "select_text"].contains(action)
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
        // AppKit can deliver even window-numbered keys to its retained key
        // window. Choose a supported element-bound insertion before dispatch
        // when addressing another window; never retry keys after a write.
        var addressedText = false
        if action == "type", text?.isEmpty == false, !foreground, let element, let window,
           elementAttribute(AXUIElementCreateApplication(window.pid), kAXFocusedWindowAttribute).flatMap(accessibilityWindowID) != window.windowID,
           let owner = elementAttribute(element, kAXWindowAttribute), accessibilityWindowID(owner) == window.windowID {
            var settable = DarwinBoolean(false)
            addressedText = AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue
        }
        let axAction = elementAction || action == "invoke_menu" || addressedText
        let alternateHover = try updateHover(target, reveal: action == "hover")
        var backgroundRelease: CGEvent?
        defer {
            if let backgroundRelease, let window,
               processLaunchDate(window.pid) == window.launched,
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
            let activationError = requestApplicationActivation(app)
            guard activationError == .success else {
                throw ComputerFailure("action_refused", "Application activation was refused (\(activationError.rawValue)); no input was sent.")
            }
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
        let foregroundWindowID: CGWindowID?
        if ticket.scope != .screen || element != nil { foregroundWindowID = window?.windowID }
        else if let foregroundPID { foregroundWindowID = focusedWindowID(foregroundPID, current: try windows(), fallbackLayer: 0) }
        else { foregroundWindowID = nil }
        var screenTargetFocused = false
        var evidence: [String: Any] = [:]
        if action == "hover", alternateHover {
            evidence["hover_route"] = "accessibility"
        } else if action == "invoke_menu" {
            guard let window, ticket.scope != .screen else { throw ComputerFailure("invalid_arguments", "invoke_menu requires an observed application window.") }
            evidence = try await invokeMenu(menuPath(args["path"]), window: window)
        } else if addressedText, let element, let text, let window {
            evidence = try await insertSelectedText(text, element: element, replace: args["replace"] as? Bool == true) {
                try Task.checkCancellation()
                guard try windows().contains(window) else {
                    throw ComputerFailure("stale_snapshot", "The target changed during text insertion; observe before another action.")
                }
            }
        } else if axAction, let element {
            evidence = try accessibilityInput(action, args: args, element: element)
        } else {
            if ["type", "key", "keys", "paste"].contains(action) {
                if let element {
                    guard let window else { throw ComputerFailure("invalid_element", "The element has no target window.") }
                    let app = AXUIElementCreateApplication(window.pid)
                    let focusError = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    // Cross-process web providers publish focus asynchronously.
                    // Submit focus once and poll readback; never replay a click,
                    // activate the app, or send a key to discover whether it took.
                    let deadline = ProcessInfo.processInfo.systemUptime + 1
                    while true {
                        try Task.checkCancellation()
                        guard try windows().contains(window) else { throw ComputerFailure("stale_snapshot", "The target window changed during focus confirmation.") }
                        let focused = elementAttribute(app, kAXFocusedUIElementAttribute)
                        if keyboardFocusMatches(element, window: window, windowBound: !foreground) { break }
                        guard ProcessInfo.processInfo.systemUptime < deadline else {
                            throw ComputerFailure("focus_unconfirmed", "The target element did not acquire keyboard focus; no keys were sent.", evidence: [
                                "focus_set_error": focusError.rawValue, "target_role": attribute(element, kAXRoleAttribute) as? String ?? "",
                                "target_focused": attribute(element, kAXFocusedAttribute) as? Bool ?? false,
                                "focused_role": focused.flatMap { attribute($0, kAXRoleAttribute) as? String } ?? "",
                                "target_window_id": window.windowID,
                                "element_window_id": elementAttribute(element, kAXWindowAttribute).flatMap(accessibilityWindowID) ?? 0,
                                "focused_window_id": elementAttribute(app, kAXFocusedWindowAttribute).flatMap(accessibilityWindowID) ?? 0,
                            ])
                        }
                        try await Task.sleep(nanoseconds: 20_000_000)
                    }
                } else if !foreground {
                    throw ComputerFailure("focus_unconfirmed", "Background keyboard input requires a target element. A canvas may require explicit foreground delivery.")
                }
            }
            let source = CGEventSource(stateID: .privateState)
            source?.localEventsSuppressionInterval = 0
            let pointerFrame = window.flatMap { windowElement($0).flatMap(elementFrame) }
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
                        // Drag images and other auxiliary surfaces can belong to
                        // this PID without taking focus from its document window.
                        guard foregroundPID.flatMap({ focusedWindowID($0, current: currentWindows, fallbackLayer: window?.layer ?? 0) }) == foregroundWindowID else {
                            throw ComputerFailure("focus_changed", "Foreground input stopped because another window became active.")
                        }
                    }
                }
                if keyboard, let element, let window, !keyboardFocusMatches(element, window: window, windowBound: !foreground) {
                    throw ComputerFailure("focus_changed", "Keyboard input stopped because the addressed element lost focus.")
                }
            }
            func post(_ event: CGEvent) throws {
                try checkpoint()
                deliver(event, window: window, foreground: foreground)
            }
            func keyboardEvent(_ event: CGEvent) throws -> CGEvent {
                if !foreground, let window { return try windowKeyboardEvent(event, window: window) }
                return event
            }
            func mouse(_ type: CGEventType, _ point: CGPoint) throws -> CGEvent {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
                    throw ComputerFailure("input_failed", "macOS could not create a mouse event.")
                }
                event.flags = modifiers.union(chord?.1 ?? [])
                // A drag is one held click. Web views reject a zero-click-count
                // down even though custom AppKit mouse handlers may accept it.
                if action == "drag" { event.setIntegerValueField(.mouseEventClickState, value: 1) }
                if foreground { return event }
                guard let window else { throw ComputerFailure("window_not_found", "Background input needs an observed window.") }
                return try windowPointerEvent(event, window: window, windowFrame: pointerFrame)
            }
            func sendKey(_ code: CGKeyCode?, flags: CGEventFlags) async throws {
                try await withHeldChord(code, flags: flags.union(action == "type" ? [] : modifiers), duration: action == "type" ? 0 : duration, source: source, prepare: keyboardEvent, post: post,
                    release: { deliver($0, window: window, foreground: foreground) }, checkpoint: checkpoint) {}
            }
            func pasteContent(_ content: NSPasteboardItem) async throws {
                try await withPasteContent(content) {
                    try checkpoint()
                    if !foreground, (action == "type" || (modifiers.isEmpty && duration == 0)), let window,
                       let item = try pasteMenuItem(window) {
                        try checkpoint()
                        guard (attribute(item, kAXMenuItemCmdCharAttribute) as? String)?.lowercased() == "v",
                              (attribute(item, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.doubleValue == 0,
                              attribute(item, kAXEnabledAttribute) as? Bool == true else {
                            throw ComputerFailure("menu_structure_changed", "The native paste command changed; no paste was issued.")
                        }
                        let error = AXUIElementPerformAction(item, kAXPressAction as CFString)
                        guard error == .success else { throw ComputerFailure("paste_refused", "The native paste command was refused (\(error.rawValue)); observe before retrying.") }
                        evidence["paste_route"] = "accessibility_menu"
                    } else {
                        evidence["paste_route"] = "keyboard"
                        try await sendKey(9, flags: .maskCommand)
                    }
                }
            }
            try await withHeldChord(["click", "drag"].contains(action) ? chord?.0 : nil,
                flags: ["click", "scroll", "drag"].contains(action) ? modifiers.union(chord?.1 ?? []) : [],
                source: source, prepare: keyboardEvent, post: post, release: { deliver($0, window: window, foreground: foreground) }, checkpoint: checkpoint) {
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
                    try await holdInput(0.016, checkpoint: checkpoint)
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
                    else if let window { try post(windowPointerEvent(event, window: window, windowFrame: pointerFrame)) }
                } else if let paste {
                    try await pasteContent(paste)
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
                    if let unicodePaste {
                        evidence["text_route"] = "clipboard"
                        try await pasteContent(unicodePaste)
                    } else {
                        evidence["text_route"] = "unicode_events"
                        var expected: String?
                        if supplementaryText {
                            guard let element, let value = attribute(element, kAXValueAttribute) as? String,
                                  let encoded = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(encoded) == AXValueGetTypeID() else {
                                throw ComputerFailure("foreground_required", "Background supplementary text requires readable text and selection for delivery confirmation; no characters were sent.")
                            }
                            var range = CFRange()
                            guard AXValueGetValue(encoded as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
                                  range.location <= value.utf16.count, range.length <= value.utf16.count - range.location else {
                                throw ComputerFailure("foreground_required", "The target selection cannot confirm supplementary text insertion; no characters were sent.")
                            }
                            expected = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
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
                            let routedDown = try keyboardEvent(down), routedUp = try keyboardEvent(up)
                            try post(routedDown)
                            deliver(routedUp, window: window, foreground: foreground)
                            try await Task.sleep(nanoseconds: 2_000_000)
                        }
                        if let expected, let element {
                            let deadline = ProcessInfo.processInfo.systemUptime + 1
                            while attribute(element, kAXValueAttribute) as? String != expected {
                                try checkpoint()
                                guard ProcessInfo.processInfo.systemUptime < deadline else {
                                    throw ComputerFailure("text_unconfirmed", "The application did not retain the complete supplementary text. Input may have partly completed; observe before continuing, and do not replay the write blindly.", evidence: ["text_route": "unicode_events", "value_matches": false])
                                }
                                try await Task.sleep(nanoseconds: 20_000_000)
                            }
                            evidence["value_matches"] = true
                        }
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

private func focusedWindowID(_ pid: pid_t, current: [WindowIdentity], fallbackLayer: Int) -> CGWindowID? {
    if let focused = elementAttribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute) {
        if let id = accessibilityWindowID(focused) { return id }
        let matches = current.filter { $0.pid == pid && $0.frame == elementFrame(focused) }
        return matches.count == 1 ? matches.first?.windowID : nil
    }
    return current.first { $0.pid == pid && $0.layer == fallbackLayer }?.windowID
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
