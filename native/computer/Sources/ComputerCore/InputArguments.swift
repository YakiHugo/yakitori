import AppKit

func validateInput(_ action: String, _ args: [String: Any]) throws {
    _ = try inputDuration(args); _ = try inputModifiers(args["modifiers"])
    if let delivery = args["delivery"], !["foreground", "background"].contains(delivery as? String ?? "") { throw ComputerFailure("invalid_arguments", "delivery must be background or foreground.") }
    if let space = args["coordinate_space"], !["screen", "screenshot", "normalized"].contains(space as? String ?? "") { throw ComputerFailure("invalid_arguments", "Unknown coordinate space.") }
    if let after = args["after"], ObservationMode(rawValue: after as? String ?? "") == nil { throw ComputerFailure("invalid_arguments", "after must be ax, vision, or both.") }
    if args["expect"] != nil { _ = try AXExpectation(args["expect"]); _ = try waitTimeout(args) }
    if args["selector"] != nil { _ = try AXExpectation(args["selector"]) }
    for key in ["x", "y", "to_x", "to_y", "dx", "dy", "duration", "timeout"] where args[key] != nil {
        guard let number = args[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
            throw ComputerFailure("invalid_arguments", "\(key) must be a finite number.")
        }
    }
    for key in ["text", "prefix", "suffix", "key", "action_name", "format", "plain_text"] where args[key] != nil {
        guard args[key] is String else { throw ComputerFailure("invalid_arguments", "\(key) must be a string.") }
    }
    switch action {
    case "key": _ = try keyChord(args["key"] as? String)
    case "keys":
        guard let keys = args["keys"] as? [String], !keys.isEmpty, keys.count <= 64 else { throw ComputerFailure("invalid_arguments", "keys requires 1...64 chords.") }
        for key in keys { _ = try keyChord(key) }
    case "paste": _ = try pasteboardItem(args)
    case "type":
        guard args["text"] is String else { throw ComputerFailure("invalid_arguments", "type requires text.") }
    case "select_text":
        guard let text = args["text"] as? String, !text.isEmpty,
              TextSelection(rawValue: args["selection_type"] as? String ?? "text") != nil else { throw ComputerFailure("invalid_arguments", "select_text requires nonempty text and a valid selection_type.") }
    case "set_value":
        guard let value = args["value"], value is String || value is NSNumber else { throw ComputerFailure("invalid_arguments", "set_value requires value.") }
    case "perform_action":
        guard args["action_name"] is String else { throw ComputerFailure("invalid_arguments", "perform_action requires action_name.") }
    case "press", "click", "scroll", "drag": break
    default: throw ComputerFailure("invalid_arguments", "Unsupported native input action.")
    }
}
