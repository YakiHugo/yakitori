import ApplicationServices
import Foundation

public struct ComputerFailure: Error {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
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
}

struct InputTarget {
    let window: WindowIdentity?
    let element: AXUIElement?
    let point: CGPoint?
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

    func target(_ args: [String: Any]) throws -> InputTarget {
        let hasElement = args["element"] != nil
        let hasPoint = args["x"] != nil || args["y"] != nil
        guard !hasElement || !hasPoint else {
            throw ComputerFailure("invalid_arguments", "Choose either an element or screenshot coordinates, not both.")
        }
        if hasElement {
            guard let index = args["element"] as? Int, elements.indices.contains(index) else {
                throw ComputerFailure("invalid_element", "The element must be an index in the latest snapshot.")
            }
            let observed = elements[index]
            return InputTarget(window: observed.window, element: observed.value, point: nil)
        }
        if hasPoint {
            guard let x = args["x"] as? Double, let y = args["y"] as? Double else {
                throw ComputerFailure("invalid_arguments", "Screenshot input requires numeric x and y together.")
            }
            let point = try point(x: x, y: y)
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
    }

    func point(x: Double, y: Double) throws -> CGPoint {
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
    // AX has no public CGWindowID. Match the exact observed frame; ambiguous
    // matches deliberately keep the pixel path instead of choosing a window.
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard Date() < deadline else { return nil }
        if elementFrame(candidate) == window.frame { matches.append(candidate) }
    }
    return matches.count == 1 ? matches[0] : nil
}

func accessibilityTree(_ roots: [(WindowIdentity, AXUIElement)], deadline: Date = Date().addingTimeInterval(1)) -> (rows: [[String: Any]], elements: [ObservedElement], truncated: Bool) {
    var queue = roots
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
        let (window, element) = queue[index]
        index += 1
        guard visited.insert(element).inserted else { continue }
        if Date() >= deadline { truncated = true; break }
        AXUIElementSetMessagingTimeout(element, 0.2)
        var row: [String: Any] = ["element": elements.count, "pid": window.pid, "window_id": window.windowID]
        for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
            if let value = attribute(element, name) as? String { row[key] = String(value.prefix(1000)) }
        }
        // Secure fields must never be included in the text observation.
        let secure = attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
        if !secure, let value = attribute(element, kAXValueAttribute) {
            if let string = value as? String { row["value"] = String(string.prefix(1000)) }
            else if let number = value as? NSNumber { row["value"] = number }
        }
        var actions: CFArray?
        if AXUIElementCopyActionNames(element, &actions) == .success { row["actions"] = actions as? [String] ?? [] }
        let rowBytes = (try? JSONSerialization.data(withJSONObject: row).count) ?? 0
        if bytes + rowBytes > 256 * 1024 { truncated = true; break }
        bytes += rowBytes
        rows.append(row)
        elements.append(ObservedElement(value: element, window: window))
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        queue.append(contentsOf: children.prefix(max(0, nodeBudget - queue.count)).map { (window, $0) })
    }
    return (rows, elements, truncated || index < queue.count || queue.count >= nodeBudget)
}
