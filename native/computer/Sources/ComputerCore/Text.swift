import AppKit
import ApplicationServices

enum TextSelection: String { case text, cursorBefore = "cursor_before", cursorAfter = "cursor_after" }

func selectedRange(in value: String, text: String, prefix: String?, suffix: String?, kind: TextSelection) throws -> CFRange {
    guard !text.isEmpty else { throw ComputerFailure("invalid_arguments", "select_text requires nonempty text.") }
    var search = value.startIndex
    var matches: [Range<String.Index>] = []
    while search < value.endIndex, let range = value.range(of: text, range: search..<value.endIndex) {
        if (prefix.map { value[..<range.lowerBound].hasSuffix($0) } ?? true) &&
           (suffix.map { value[range.upperBound...].hasPrefix($0) } ?? true) { matches.append(range) }
        search = value.index(after: range.lowerBound)
    }
    guard matches.count == 1, let match = matches.first else {
        throw ComputerFailure("ambiguous_text", "The selection must match exactly once; provide prefix/suffix to disambiguate.")
    }
    let range = NSRange(match, in: value)
    switch kind {
    case .text: return CFRange(location: range.location, length: range.length)
    case .cursorBefore: return CFRange(location: range.location, length: 0)
    case .cursorAfter: return CFRange(location: range.location + range.length, length: 0)
    }
}

func confirmSelection(_ range: CFRange, element: AXUIElement) throws {
    var range = range
    guard let encoded = AXValueCreate(.cfRange, &range),
          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, encoded) == .success,
          let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else {
        throw ComputerFailure("selection_unconfirmed", "The target did not accept the requested text selection; no text was sent.")
    }
    var actual = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &actual), actual.location == range.location, actual.length == range.length else {
        throw ComputerFailure("selection_unconfirmed", "The target did not confirm the requested text selection; no text was sent.")
    }
}

func insertTextValue(_ text: String, element: AXUIElement, replace: Bool, checkpoint: () throws -> Void) async throws -> [String: Any] {
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard attribute(element, kAXFocusedAttribute) as? Bool == true else {
        throw ComputerFailure("focus_unconfirmed", "The addressed text control did not confirm focus; no text was sent.")
    }
    guard let value = attribute(element, kAXValueAttribute) as? String else {
        throw ComputerFailure("selection_unconfirmed", "Addressed text insertion requires readable text; no text was sent.")
    }
    if replace { try confirmSelection(CFRange(location: 0, length: value.utf16.count), element: element) }
    guard let encoded = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(encoded) == AXValueGetTypeID() else {
        throw ComputerFailure("selection_unconfirmed", "The target does not expose a text selection; no text was sent.")
    }
    var range = CFRange()
    guard AXValueGetValue(encoded as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
          range.location <= value.utf16.count, range.length <= value.utf16.count - range.location else {
        throw ComputerFailure("selection_unconfirmed", "The target selection cannot confirm insertion; no text was sent.")
    }
    let expected = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
    try checkpoint()
    var currentRange = CFRange()
    guard attribute(element, kAXValueAttribute) as? String == value,
          let currentSelection = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(currentSelection) == AXValueGetTypeID(),
          AXValueGetValue(currentSelection as! AXValue, .cfRange, &currentRange), currentRange.location == range.location, currentRange.length == range.length else {
        throw ComputerFailure("text_changed", "The target text or selection changed while preparing insertion; no text was sent. Observe again.")
    }
    let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, expected as CFString)
    guard error == .success else {
        throw ComputerFailure("text_unconfirmed", "Addressed insertion was refused. Observe before continuing; do not replay the write blindly.", evidence: ["text_route": "accessibility_value", "set_error": error.rawValue])
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    while attribute(element, kAXValueAttribute) as? String != expected {
        try checkpoint()
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw ComputerFailure("text_unconfirmed", "The target did not retain the complete text. Observe before continuing; do not replay the write blindly.", evidence: ["text_route": "accessibility_value", "value_matches": false])
        }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    try checkpoint()
    do {
        try confirmSelection(CFRange(location: range.location + text.utf16.count, length: 0), element: element)
    } catch let error as ComputerFailure where error.code == "selection_unconfirmed" {
        throw ComputerFailure("text_unconfirmed", "The text was inserted but its final caret could not be confirmed. Observe before continuing; do not replay the write.", evidence: ["text_route": "accessibility_value", "value_matches": true])
    }
    return ["text_route": "accessibility_value", "value_matches": true]
}

func accessibilityInput(_ action: String, args: [String: Any], element: AXUIElement) throws -> [String: Any] {
    switch action {
    case "press", "perform_action":
        let name: String
        if action == "press" { name = kAXPressAction }
        else {
            guard let requested = args["action_name"] as? String else { throw ComputerFailure("invalid_arguments", "perform_action requires action_name from the observed actions.") }
            name = requested
        }
        var available: CFArray?
        guard AXUIElementCopyActionNames(element, &available) == .success,
              (available as? [String] ?? []).contains(name) else {
            throw ComputerFailure("action_refused", "The target does not currently expose \(name).")
        }
        let error = AXUIElementPerformAction(element, name as CFString)
        guard error == .success else { throw ComputerFailure("action_refused", "\(name) failed (\(error.rawValue)); observe before another input.") }
        return [:]
    case "set_value":
        guard let value = args["value"], value is String || value is NSNumber else { throw ComputerFailure("invalid_arguments", "set_value requires a string, number, or boolean value.") }
        let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
        guard error == .success else { throw ComputerFailure("action_refused", "AXValue was refused (\(error.rawValue)); the app may not support direct value changes.") }
        let actual = attribute(element, kAXValueAttribute)
        return ["value_matches": actual.map { CFEqual($0, value as CFTypeRef) } ?? false]
    case "select_text":
        guard let value = attribute(element, kAXValueAttribute) as? String,
              let text = args["text"] as? String, let kind = TextSelection(rawValue: args["selection_type"] as? String ?? "text") else {
            throw ComputerFailure("invalid_arguments", "select_text requires readable text, text, and selection_type=text/cursor_before/cursor_after.")
        }
        let range = try selectedRange(in: value, text: text, prefix: args["prefix"] as? String, suffix: args["suffix"] as? String, kind: kind)
        try confirmSelection(range, element: element)
        return ["selection": ["location": range.location, "length": range.length]]
    default: preconditionFailure("Unexpected AX input action")
    }
}
