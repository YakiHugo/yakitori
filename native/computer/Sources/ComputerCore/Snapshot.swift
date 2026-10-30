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
    var truncated = false
    var mode: ObservationMode = .both
    var revisions: [Int32: UInt64] = [:]

    func target(_ args: [String: Any]) throws -> InputTarget {
        let hasElement = args["element"] != nil || args["selector"] != nil
        let hasPoint = args["x"] != nil || args["y"] != nil
        guard !hasElement || !hasPoint else {
            throw ComputerFailure("invalid_arguments", "Choose either an element or screenshot coordinates, not both.")
        }
        if hasElement {
            let index: Int?
            if args["selector"] != nil {
                guard args["element"] == nil else { throw ComputerFailure("invalid_arguments", "Choose selector or element, not both.") }
                guard !truncated else { throw ComputerFailure("tree_truncated", "A partial AX tree cannot prove selector uniqueness; observe a subtree or address an observed element explicitly.") }
                let selector = try AXExpectation(args["selector"])
                guard selector.exists else { throw ComputerFailure("invalid_arguments", "An input selector must identify an existing element.") }
                let matches = rows.filter(selector.matches)
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
        let selected: [WindowIdentity]
        switch scope {
        case .window: selected = current.filter { $0.windowID == windows.first?.windowID }
        case .app: selected = current.filter { $0.pid == windows.first?.pid }
        case .screen: selected = current.filter { $0.layer == 0 && $0.frame.intersects(frame) }
        }
        guard id == self.id, selected == windows, display.map({ displays.contains($0) }) ?? true else {
            throw ComputerFailure("stale_snapshot", "Observe again; the target windows or display changed, or the snapshot was already used.")
        }
        for (pid, revision) in revisions where try NativeResources.revision(pid) != revision {
            throw ComputerFailure("stale_snapshot", "Another helper changed this app after observation; observe again.")
        }
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
        guard x.isFinite, y.isFinite, x >= 0, y >= 0,
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

func windowElement(_ window: WindowIdentity, deadline: Date = Date().addingTimeInterval(1), requireFrame: Bool = true) -> AXUIElement? {
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    // Prefer the optional native window-ID bridge. The public fallback requires
    // an exact, unique frame and never guesses between overlapping windows.
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard Date() < deadline else { return nil }
        if let id = accessibilityWindowID(candidate) {
            if id == window.windowID && (!requireFrame || elementFrame(candidate) == window.frame) { matches.append(candidate) }
        } else if elementFrame(candidate) == window.frame { matches.append(candidate) }
    }
    return matches.count == 1 ? matches[0] : nil
}

func accessibilityTree(_ roots: [(WindowIdentity, AXUIElement)], applicationRoots: [(WindowIdentity, AXUIElement)] = [], deadline: Date = Date().addingTimeInterval(1)) -> (rows: [[String: Any]], elements: [ObservedElement], truncated: Bool) {
    var queue = roots.map { ($0.0, $0.1, Optional<Int>.none, false) } + applicationRoots.map { ($0.0, $0.1, Optional<Int>.none, true) }
    var elements: [ObservedElement] = []
    var rows: [[String: Any]] = []
    var visited = Set<AXUIElement>()
    // A hostile or broken AX provider must not grow the reply indefinitely.
    // This is a per-observation memory boundary, not an application quota.
    let nodeBudget = 500
    var index = 0
    var bytes = 0
    var truncated = false
    while index < queue.count, elements.count < nodeBudget {
        let (window, element, parent, applicationUI) = queue[index]
        index += 1
        guard visited.insert(element).inserted else { continue }
        if Date() >= deadline { truncated = true; break }
        AXUIElementSetMessagingTimeout(element, 0.2)
        var row: [String: Any] = ["element": elements.count, "pid": window.pid]
        row[applicationUI ? "anchor_window_id" : "window_id"] = window.windowID
        if let parent { row["parent"] = parent }
        if let frame = elementFrame(element) { row["frame"] = frameData(frame) }
        for (key, name) in [("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute)] {
            if let value = attribute(element, name) as? Bool { row[key] = value }
        }
        for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
            if let value = attribute(element, name) as? String {
                row[key] = String(value.prefix(1000))
                if value.count > 1000 { row["truncated_attributes"] = (row["truncated_attributes"] as? [String] ?? []) + [key] }
            }
        }
        // Secure fields must never be included in the text observation.
        let secure = attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
        if !secure, let value = attribute(element, kAXValueAttribute) {
            if let string = value as? String {
                row["value"] = String(string.prefix(1000))
                if string.count > 1000 { row["truncated_attributes"] = (row["truncated_attributes"] as? [String] ?? []) + ["value"] }
            }
            else if let number = value as? NSNumber { row["value"] = number }
        }
        var actions: CFArray?
        if AXUIElementCopyActionNames(element, &actions) == .success { row["actions"] = actions as? [String] ?? [] }
        let rowBytes = (try? JSONSerialization.data(withJSONObject: row).count) ?? 0
        if bytes + rowBytes > 256 * 1024 { truncated = true; break }
        bytes += rowBytes
        rows.append(row)
        elements.append(ObservedElement(value: element, window: window, applicationUI: applicationUI))
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        let parentIndex = elements.count - 1
        queue.append(contentsOf: children.prefix(max(0, nodeBudget - queue.count)).map { (window, $0, Optional(parentIndex), applicationUI) })
    }
    return (rows, elements, truncated || index < queue.count || queue.count >= nodeBudget)
}
