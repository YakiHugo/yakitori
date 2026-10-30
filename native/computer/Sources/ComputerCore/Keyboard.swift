import AppKit

func inputModifiers(_ value: Any?) throws -> CGEventFlags {
    guard let value else { return [] }
    guard let names = value as? [String] else { throw ComputerFailure("invalid_arguments", "modifiers must be an array of names.") }
    var flags: CGEventFlags = []
    for name in names {
        switch name.lowercased() {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "function": flags.insert(.maskSecondaryFn)
        default: throw ComputerFailure("invalid_arguments", "Unknown modifier: \(name).")
        }
    }
    return flags
}

func inputDuration(_ args: [String: Any]) throws -> TimeInterval {
    let duration = (args["duration"] as? NSNumber)?.doubleValue ?? 0
    // Native held-input cleanup must stay bounded even when a model supplies an
    // accidental huge duration. Ten seconds is a local execution safety bound.
    guard args["duration"] == nil || args["duration"] is NSNumber,
          duration.isFinite, (0...10).contains(duration) else {
        throw ComputerFailure("invalid_arguments", "duration must be within the 10-second held-input safety boundary.")
    }
    return duration
}

func withHeldChord<T>(_ code: CGKeyCode?, flags: CGEventFlags, duration: TimeInterval = 0,
    source: CGEventSource?, prepare: (CGEvent) throws -> CGEvent = { $0 }, post: (CGEvent) throws -> Void, release: (CGEvent) -> Void,
    checkpoint: () throws -> Void = { try Task.checkCancellation() },
    body: () async throws -> T) async throws -> T {
    var releases: [CGEvent] = []
    defer {
        for event in releases.reversed() { event.timestamp = DispatchTime.now().uptimeNanoseconds; release(event) }
    }
    let modifiers: [(CGKeyCode, CGEventFlags)] = [(55, .maskCommand), (56, .maskShift), (58, .maskAlternate), (59, .maskControl), (63, .maskSecondaryFn)]
    var keys = modifiers.filter { flags.contains($0.1) }
    if let code { keys.append((code, [])) }
    var held: CGEventFlags = []
    for (key, modifier) in keys {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
            throw ComputerFailure("input_failed", "macOS could not create a keyboard event.")
        }
        let previous = held
        held.formUnion(modifier)
        down.flags = held
        up.flags = modifier.isEmpty ? held : previous
        if !modifier.isEmpty { down.type = .flagsChanged; up.type = .flagsChanged }
        let preparedDown = try prepare(down), preparedUp = try prepare(up)
        try post(preparedDown)
        releases.append(preparedUp)
        try await holdInput(0.01, checkpoint: checkpoint)
    }
    let value = try await body()
    try await holdInput(duration, checkpoint: checkpoint)
    return value
}

func holdInput(_ duration: TimeInterval, checkpoint: () throws -> Void) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + duration
    while ProcessInfo.processInfo.systemUptime < deadline {
        try checkpoint()
        // Poll focus/cancellation while a button or modifier is held, rather
        // than leaving it held for the entire requested duration after takeover.
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(min(remaining, 0.025) * 1_000_000_000)) }
    }
}

func keyChord(_ value: String?) throws -> (CGKeyCode?, CGEventFlags) {
    guard let value else { throw ComputerFailure("invalid_arguments", "key requires a chord such as CMD+A or ENTER.") }
    var parts = value.uppercased().split(separator: "+").map(String.init)
    var keys: [String: CGKeyCode] = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35, "ENTER": 36, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "ESC": 53, "HOME": 115, "PAGEUP": 116, "DELETE": 117, "END": 119, "PAGEDOWN": 121, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126]
    keys.merge(["RETURN": 36, "ESCAPE": 53, "CAPSLOCK": 57, "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
        ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "[": 33, "]": 30, "-": 27, "=": 24, "PLUS": 24,
        "NUMPAD0": 82, "NUMPAD1": 83, "NUMPAD2": 84, "NUMPAD3": 85, "NUMPAD4": 86, "NUMPAD5": 87, "NUMPAD6": 88, "NUMPAD7": 89, "NUMPAD8": 91, "NUMPAD9": 92, "NUMPADENTER": 76]) { _, value in value }
    let modifierNames: [String: CGEventFlags] = ["CMD": .maskCommand, "COMMAND": .maskCommand, "SUPER": .maskCommand, "CTRL": .maskControl, "CONTROL": .maskControl, "ALT": .maskAlternate, "OPTION": .maskAlternate, "SHIFT": .maskShift, "FN": .maskSecondaryFn, "FUNCTION": .maskSecondaryFn]
    guard let key = parts.popLast() else { throw ComputerFailure("invalid_arguments", "key requires a supported key or chord.") }
    var flags: CGEventFlags = key == "PLUS" ? .maskShift : []
    let code = keys[key]
    if code == nil {
        guard let modifier = modifierNames[key] else { throw ComputerFailure("invalid_arguments", "Unsupported key chord.") }
        flags.formUnion(modifier)
    }
    for part in parts {
        guard let modifier = modifierNames[part] else { throw ComputerFailure("invalid_arguments", "Unsupported key modifier: \(part).") }
        flags.formUnion(modifier)
    }
    return (code, flags)
}
