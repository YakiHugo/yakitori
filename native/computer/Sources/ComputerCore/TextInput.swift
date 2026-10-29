import ApplicationServices
import Foundation

func textSelection(source: String, text: String, prefix: String?, suffix: String?, kind: String) throws -> CFRange {
    guard !text.isEmpty, ["text", "cursor_before", "cursor_after"].contains(kind) else {
        throw ComputerFailure("invalid_arguments", "select_text requires nonempty text and selection_type=text, cursor_before, or cursor_after.")
    }
    let value = source as NSString
    let query = (prefix ?? "") + text + (suffix ?? "")
    var search = NSRange(location: 0, length: value.length)
    var found: NSRange?
    while search.length > 0 {
        let match = value.range(of: query, options: .literal, range: search)
        if match.location == NSNotFound { break }
        guard found == nil else {
            throw ComputerFailure("selection_ambiguous", "Text matches more than once; provide immediate prefix or suffix context.")
        }
        found = NSRange(location: match.location + (prefix?.utf16.count ?? 0), length: text.utf16.count)
        let next = match.location + 1
        search = NSRange(location: next, length: value.length - next)
    }
    guard let found else { throw ComputerFailure("text_not_found", "The requested text and context were not found in the element.") }
    switch kind {
    case "cursor_before": return CFRange(location: found.location, length: 0)
    case "cursor_after": return CFRange(location: found.location + found.length, length: 0)
    default: return CFRange(location: found.location, length: found.length)
    }
}

extension Computer {
    func accessibilityInput(_ action: String, _ args: [String: Any], element: AXUIElement) throws -> [String: Any] {
        var confirmed = false
        switch action {
        case "set_value":
            guard let text = args["text"] as? String else {
                throw ComputerFailure("invalid_arguments", "set_value requires text.")
            }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
                throw ComputerFailure("value_not_settable", "This element does not expose a writable AX value; observe before choosing another input method.")
            }
            let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString)
            guard error == .success else { throw ComputerFailure("action_refused", "Setting AXValue failed (\(error.rawValue)).") }
            confirmed = attribute(element, kAXValueAttribute) as? String == text
        case "select_text":
            guard attribute(element, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
                  let source = attribute(element, kAXValueAttribute) as? String,
                  let text = args["text"] as? String,
                  args["prefix"] == nil || args["prefix"] is String,
                  args["suffix"] == nil || args["suffix"] is String,
                  args["selection_type"] == nil || args["selection_type"] is String else {
                throw ComputerFailure("invalid_arguments", "select_text requires a non-secure text element and string text/context fields.")
            }
            var range = try textSelection(source: source, text: text, prefix: args["prefix"] as? String,
                suffix: args["suffix"] as? String, kind: args["selection_type"] as? String ?? "text")
            guard let selected = AXValueCreate(.cfRange, &range),
                  AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selected) == .success,
                  let readback = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(readback) == AXValueGetTypeID() else {
                throw ComputerFailure("selection_unconfirmed", "The target did not confirm text selection; observe before continuing.")
            }
            var actual = CFRange()
            guard AXValueGetValue(readback as! AXValue, .cfRange, &actual), actual.location == range.location, actual.length == range.length else {
                throw ComputerFailure("selection_unconfirmed", "The selection readback differs from the requested range; observe before continuing.")
            }
            confirmed = true
        case "perform_action":
            guard let name = args["action_name"] as? String, !name.isEmpty else {
                throw ComputerFailure("invalid_arguments", "perform_action requires action_name from the observed element's actions.")
            }
            var names: CFArray?
            guard AXUIElementCopyActionNames(element, &names) == .success, (names as? [String] ?? []).contains(name) else {
                throw ComputerFailure("action_unavailable", "The element does not currently advertise this action; observe it again.")
            }
            let error = AXUIElementPerformAction(element, name as CFString)
            guard error == .success else { throw ComputerFailure("action_refused", "The AX action failed (\(error.rawValue)); observe before choosing another action.") }
        default: throw ComputerFailure("invalid_arguments", "Unknown accessibility action.")
        }
        return try result(["effect": confirmed ? "confirmed" : "unverified", "delivery": "accessibility",
            "message": confirmed ? "The requested AX value or selection was read back. Observe to verify any application-level result."
                : "AX accepted the action. Observe to verify the application result before continuing or retrying."])
    }
}
