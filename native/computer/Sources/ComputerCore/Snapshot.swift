import ApplicationServices
import Foundation
import Darwin

private typealias AXWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let getWindowID = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
    .map { unsafeBitCast($0, to: AXWindowID.self) }

func accessibilityWindowID(_ element: AXUIElement) -> CGWindowID? {
    guard let getWindowID else { return nil }
    var id: CGWindowID = 0
    return getWindowID(element, &id) == .success && id != 0 ? id : nil
}

public struct ComputerFailure: Error {
    public let code: String
    public let message: String
    public let evidence: [String: Any]

    public init(_ code: String, _ message: String, evidence: [String: Any] = [:]) {
        self.code = code
        self.message = message
        self.evidence = evidence
    }
}

struct WindowIdentity: Equatable {
    let pid: pid_t
    let launched: Date?
    let windowID: CGWindowID
    let frame: CGRect
    let layer: Int
}

struct DisplayIdentity: Equatable {
    let id: CGDirectDisplayID
    let frame: CGRect
}

enum ObservationMode: String { case ax, vision, both }
enum ObservationScope: String { case window, app, screen }

struct ObservedElement {
    let value: AXUIElement
    let window: WindowIdentity
    var applicationUI = false
}

struct InputTarget {
    let window: WindowIdentity?
    let element: AXUIElement?
    let point: CGPoint?
    var applicationUI = false
}

struct Snapshot {
    let id = "snapshot_" + UUID().uuidString
    let scope: ObservationScope
    let frame: CGRect
    let windows: [WindowIdentity]
    let display: DisplayIdentity?
    let imageWidth: Int?
    let imageHeight: Int?
    let elements: [ObservedElement]
    var rows: [[String: Any]] = []
    var incompleteRoots = false
    var mode: ObservationMode = .both
    var revisions: [Int32: UInt64] = [:]
    var isSubtree = false
    var visualFingerprint: Data?

    var truncated: Bool { incompleteRoots || rows.contains(where: isIncompleteAXRow) }
    var isFullWindow: Bool {
        scope == .window && !isSubtree && windows.count == 1 &&
            windows.first?.launched != nil && windows.first?.frame == frame
    }
    var hasWindowAX: Bool { isFullWindow && mode != .vision && !rows.isEmpty }

    func target(_ args: [String: Any]) throws -> InputTarget {
        let hasElement = args["element"] != nil || args["selector"] != nil
        let hasPoint = args["x"] != nil || args["y"] != nil
        guard !(hasElement && hasPoint) else {
            throw ComputerFailure("invalid_arguments", "Choose an AX element or coordinates, not both.")
        }
        if hasElement {
            let index: Int?
            if args["selector"] != nil {
                guard args["element"] == nil else { throw ComputerFailure("invalid_arguments", "Choose selector or element, not both.") }
                let selector = try AXExpectation(args["selector"])
                guard selector.exists else { throw ComputerFailure("invalid_arguments", "An input selector must identify an existing element.") }
                let matches = rows.filter(selector.matches)
                guard matches.count > 1 || !selector.coverageIncomplete(in: self) else {
                    throw ComputerFailure("tree_truncated", "A partial AX tree cannot prove selector uniqueness; observe a subtree or address an observed element explicitly.")
                }
                guard matches.count == 1 else { throw ComputerFailure("ambiguous_element", "The exact selector must match one observed element; found \(matches.count).") }
                index = matches.first?["element"] as? Int
            } else { index = args["element"] as? Int }
            guard let index, elements.indices.contains(index) else {
                throw ComputerFailure("invalid_element", "The element must be an index in the latest snapshot.")
            }
            let observed = elements[index]
            return InputTarget(window: observed.window, element: observed.value, point: nil, applicationUI: observed.applicationUI)
        }
        if hasPoint {
            guard let x = args["x"] as? Double, let y = args["y"] as? Double else {
                throw ComputerFailure("invalid_arguments", "Screenshot input requires numeric x and y together.")
            }
            let point = try point(x: x, y: y, space: args["coordinate_space"] as? String ?? "screenshot")
            let window = windows.first { $0.frame.contains(point) }
            guard scope == .screen || window != nil else {
                throw ComputerFailure("invalid_coordinates", "The point is outside the observed application's windows.")
            }
            return InputTarget(window: window, element: nil, point: point)
        }
        return InputTarget(window: scope == .screen ? nil : windows.first, element: nil, point: nil)
    }

    func validate(id: String?, windows current: [WindowIdentity], displays: [DisplayIdentity]) throws {
        let sameWindows: Bool
        switch scope {
        case .window: sameWindows = current.filter { $0.windowID == windows.first?.windowID } == windows
        case .app:
            let selected = current.filter { $0.pid == windows.first?.pid && $0.layer == 0 }
            sameWindows = selected == windows.filter { $0.layer == 0 } &&
                current.contains { $0.pid == windows.first?.pid && $0.launched == windows.first?.launched }
        case .screen: sameWindows = true
        }
        guard id == self.id, sameWindows, display.map({ displays.contains($0) }) ?? true else {
            throw ComputerFailure("stale_snapshot", "Observe again; the target windows or display changed, or the snapshot was already used.")
        }
        for (pid, revision) in revisions where try NativeResources.revision(pid) != revision {
            throw ComputerFailure("stale_snapshot", "Another helper changed this app after observation; observe again.")
        }
    }

    // Read-only frames carry no input ticket. Moves, resizes and another
    // helper's input may change pixels; process/window replacement must not.
    func validatePreview(windows current: [WindowIdentity], displays: [DisplayIdentity]) throws -> Bool {
        if let display {
            guard let active = displays.first(where: { $0.id == display.id }) else {
                throw ComputerFailure("display_not_found", "The preview display disconnected.")
            }
            return active.frame == display.frame
        }
        guard let anchor = windows.first, let launched = anchor.launched else {
            throw ComputerFailure("stale_target", "A preview requires a known process incarnation.")
        }
        let selected = current.filter { $0.pid == anchor.pid && (scope == .app || $0.windowID == anchor.windowID) }
        guard !selected.isEmpty else { throw ComputerFailure("window_not_found", "The preview target closed or is no longer visible.") }
        guard selected.allSatisfy({ $0.launched == launched }) else {
            throw ComputerFailure("stale_target", "The preview process incarnation changed; list targets again.")
        }
        return selected == windows
    }

    func point(x: Double, y: Double, space: String = "screenshot") throws -> CGPoint {
        guard x.isFinite, y.isFinite else { throw ComputerFailure("invalid_coordinates", "Coordinates must be finite.") }
        switch space {
        case "screen":
            let point = CGPoint(x: x, y: y)
            guard frame.contains(point) else { throw ComputerFailure("invalid_coordinates", "Screen coordinates must be inside the observation frame.") }
            return point
        case "normalized":
            guard x >= 0, x < 1000, y >= 0, y < 1000 else {
                throw ComputerFailure("invalid_coordinates", "Normalized coordinates must be within [0, 1000).")
            }
            return CGPoint(x: frame.minX + x * frame.width / 1000, y: frame.minY + y * frame.height / 1000)
        case "screenshot": break
        default: throw ComputerFailure("invalid_arguments", "coordinate_space must be screenshot, normalized, or screen.")
        }
        guard let imageWidth, let imageHeight else {
            throw ComputerFailure("coordinates_unavailable", "AX-only observations have no screenshot coordinates; use an element or observe in vision/both mode.")
        }
        guard x >= 0, y >= 0,
              x < Double(imageWidth), y < Double(imageHeight) else {
            throw ComputerFailure("invalid_coordinates", "Coordinates must be inside the observed screenshot in pixels.")
        }
        return CGPoint(
            x: frame.minX + x * frame.width / Double(imageWidth),
            y: frame.minY + y * frame.height / Double(imageHeight)
        )
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.2)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return value as! AXUIElement
}

func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}

func windowElement(_ window: WindowIdentity, deadline: Date = Date().addingTimeInterval(1)) -> AXUIElement? {
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    // The exact native ID joins AX to WindowServer. Their geometry can differ
    // by system-drawn borders, so frame equality is only an identity fallback
    // when the ID bridge is unavailable. Snapshot validation separately checks
    // the process incarnation and current WindowServer geometry before input.
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard Date() < deadline else { return nil }
        if let id = accessibilityWindowID(candidate) {
            if id == window.windowID { matches.append(candidate) }
        } else if elementFrame(candidate) == window.frame { matches.append(candidate) }
    }
    return matches.count == 1 ? matches[0] : nil
}

func isIncompleteAXRow(_ row: [String: Any]) -> Bool {
    row["children_incomplete"] != nil || row["unreadable_attributes"] != nil || row["truncated_attributes"] != nil
}

enum AXChildrenIncomplete: String {
    case nodeBudget = "node_budget", deadline, axError = "ax_error"
}

func boundedAXChildren(_ element: AXUIElement, limit: Int) -> (children: [AXUIElement], incomplete: AXChildrenIncomplete?) {
    var count: CFIndex = 0
    switch AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) {
    case .noValue, .attributeUnsupported: return ([], nil)
    case .success: break
    default: return ([], .axError)
    }
    if count == 0 { return ([], nil) }
    var value: CFArray?
    guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, limit), &value) == .success else {
        return ([], .axError)
    }
    return decodedAXChildren(value, expected: count, limit: limit)
}

func decodedAXChildren(_ value: CFTypeRef?, expected: Int? = nil, limit: Int) -> (children: [AXUIElement], incomplete: AXChildrenIncomplete?) {
    guard let items = value as? [AnyObject] else { return ([], .axError) }
    let children = items.prefix(limit).compactMap { item -> AXUIElement? in
        guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
        return (item as! AXUIElement)
    }
    let count = expected ?? items.count
    if children.count != min(count, limit) { return (children, .axError) }
    return (children, count > limit ? .nodeBudget : nil)
}

func accessibilityTree(
    _ roots: [(WindowIdentity, AXUIElement)],
    applicationRoots: [(WindowIdentity, AXUIElement)] = [],
    deadline: Date = Date().addingTimeInterval(1),
    cancellation: AccessibilityCancellation? = nil,
    copyChildren: (AXUIElement, Int) -> (children: [AXUIElement], incomplete: AXChildrenIncomplete?) = boundedAXChildren,
    copyAttribute: (AXUIElement, CFString, UnsafeMutablePointer<CFTypeRef?>) -> AXError = AXUIElementCopyAttributeValue
) throws -> (rows: [[String: Any]], elements: [ObservedElement], incompleteRoots: Bool) {
    var queue = roots.map { ($0.0, $0.1, Optional<Int>.none, false) } + applicationRoots.map { ($0.0, $0.1, Optional<Int>.none, true) }
    var elements: [ObservedElement] = []
    var rows: [[String: Any]] = []
    var visited = Set<AXUIElement>()
    let visibleNodeSafetyLimit = 500
    let visitedNodeSafetyLimit = 2_000
    var index = 0
    var bytes = 0
    var incompleteRoots = false
    if queue.count > visitedNodeSafetyLimit {
        queue = Array(queue.prefix(visitedNodeSafetyLimit))
        incompleteRoots = true
    }
    func markIncomplete(_ parent: Int?, _ reason: AXChildrenIncomplete) {
        if let parent { rows[parent]["children_incomplete"] = rows[parent]["children_incomplete"] ?? reason.rawValue }
        else { incompleteRoots = true }
    }
    while index < queue.count {
        try cancellation?.check()
        let (window, element, parent, applicationUI) = queue[index]
        index += 1
        guard visited.insert(element).inserted else { continue }
        if Date() >= deadline { markIncomplete(parent, .deadline); continue }
        if elements.count >= visibleNodeSafetyLimit { markIncomplete(parent, .nodeBudget); continue }
        AXUIElementSetMessagingTimeout(element, 0.2)
        var row: [String: Any] = ["element": elements.count, "pid": window.pid]
        var unreadable: [String] = []
        var clipped: [String] = []
        func read(_ key: String, _ name: String) throws -> CFTypeRef? {
            try cancellation?.check()
            guard Date() < deadline else { unreadable.append(key); return nil }
            var value: CFTypeRef?
            let status = copyAttribute(element, name as CFString, &value)
            if status == .success, let value { return value }
            if status != .attributeUnsupported && status != .noValue { unreadable.append(key) }
            return nil
        }
        func storeText(_ value: String, as key: String) {
            let sample = value.unicodeScalars.prefix(1001)
            if sample.count > 1000 { clipped.append(key) }
            row[key] = String(sample.prefix(1000))
        }
        row[applicationUI ? "anchor_window_id" : "window_id"] = window.windowID
        if let parent { row["parent"] = parent }
        for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
                             ("identifier", kAXIdentifierAttribute), ("subrole", kAXSubroleAttribute), ("role_description", kAXRoleDescriptionAttribute),
                             ("placeholder", kAXPlaceholderValueAttribute), ("help", kAXHelpAttribute)] {
            if let raw = try read(key, name) {
                if let value = raw as? String { storeText(value, as: key) }
                else { unreadable.append(key) }
            }
        }
        for (key, name) in [("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute), ("selected", kAXSelectedAttribute), ("expanded", kAXExpandedAttribute)] {
            if let value = try read(key, name) as? Bool { row[key] = value }
        }
        if row["subrole"] as? String != kAXSecureTextFieldSubrole && !unreadable.contains("subrole") {
            if let value = try read("value", kAXValueAttribute) {
                if let string = value as? String { storeText(string, as: "value") }
                else if let number = value as? NSNumber { row["value"] = number }
            }
        } else { unreadable.append("value") }
        if let url = try read("url", kAXURLAttribute) {
            if let value = url as? URL { storeText(value.absoluteString, as: "url") }
            else if let value = url as? String { storeText(value, as: "url") }
        }
        try cancellation?.check()
        let actions = Date() < deadline ? accessibilityActions(element) : []
        if !actions.isEmpty { row["actions"] = actions.prefix(32).map { String($0.unicodeScalars.prefix(128)) } }
        let remaining = visitedNodeSafetyLimit - queue.count
        let branch: (children: [AXUIElement], incomplete: AXChildrenIncomplete?)
        if Date() >= deadline { branch = ([], .deadline) }
        else if remaining == 0 { branch = ([], .nodeBudget) }
        else { branch = copyChildren(element, min(visibleNodeSafetyLimit, remaining)) }
        if let incomplete = branch.incomplete { row["children_incomplete"] = incomplete.rawValue }
        var layoutOnly = parent != nil && branch.incomplete == nil && unreadable.isEmpty && clipped.isEmpty && actions.isEmpty &&
            [kAXGroupRole, kAXSplitGroupRole].contains(row["role"] as? String ?? "") && row["focused"] as? Bool != true &&
            row["selected"] == nil && row["expanded"] == nil &&
            ["title", "description", "value", "identifier", "help", "placeholder", "subrole", "url"].allSatisfy { row[$0] == nil || row[$0] as? String == "" }
        if layoutOnly {
            let horizontal = try read("horizontal_scroll_bar", kAXHorizontalScrollBarAttribute)
            let vertical = try read("vertical_scroll_bar", kAXVerticalScrollBarAttribute)
            layoutOnly = horizontal == nil && vertical == nil && unreadable.isEmpty
        }
        if !unreadable.isEmpty { row["unreadable_attributes"] = unreadable }
        if !clipped.isEmpty { row["truncated_attributes"] = clipped }
        let childParent: Int?
        if layoutOnly { childParent = parent }
        else {
            try cancellation?.check()
            if Date() < deadline, let frame = elementFrame(element) { row["frame"] = frameData(frame) }
            let rowBytes = try JSONSerialization.data(withJSONObject: row).count
            if bytes + rowBytes > 256 * 1024 { markIncomplete(parent, .nodeBudget); continue }
            bytes += rowBytes
            childParent = elements.count
            rows.append(row)
            elements.append(ObservedElement(value: element, window: window, applicationUI: applicationUI))
        }
        queue.append(contentsOf: branch.children.map { (window, $0, childParent, applicationUI) })
    }
    try cancellation?.check()
    return (rows, elements, incompleteRoots)
}
