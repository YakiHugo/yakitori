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
}

struct Snapshot {
    let id = "snapshot_" + UUID().uuidString
    let window: WindowIdentity
    let imageWidth: Int
    let imageHeight: Int
    let elements: [AXUIElement]

    func validate(id: String?, window current: WindowIdentity) throws {
        guard id == self.id, current == window else {
            throw ComputerFailure("stale_snapshot", "Observe the window again; its identity or geometry changed, or the snapshot was already used.")
        }
    }

    func point(x: Double, y: Double) throws -> CGPoint {
        guard x.isFinite, y.isFinite, x >= 0, y >= 0,
              x < Double(imageWidth), y < Double(imageHeight) else {
            throw ComputerFailure("invalid_coordinates", "Coordinates must be inside the observed screenshot in pixels.")
        }
        return CGPoint(
            x: window.frame.minX + x * window.frame.width / Double(imageWidth),
            y: window.frame.minY + y * window.frame.height / Double(imageHeight)
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

func windowElement(_ window: WindowIdentity) -> AXUIElement? {
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    // AX has no public CGWindowID. Match the exact observed frame; ambiguous
    // matches deliberately keep the pixel path instead of choosing a window.
    let deadline = Date().addingTimeInterval(1)
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard Date() < deadline else { return nil }
        if elementFrame(candidate) == window.frame { matches.append(candidate) }
    }
    return matches.count == 1 ? matches[0] : nil
}

func accessibilityTree(_ root: AXUIElement?) -> (rows: [[String: Any]], elements: [AXUIElement], truncated: Bool) {
    guard let root else { return ([], [], false) }
    var queue = [root]
    var elements: [AXUIElement] = []
    var rows: [[String: Any]] = []
    var visited = Set<AXUIElement>()
    // A hostile or broken AX provider must not grow the reply indefinitely.
    // This is a per-observation memory boundary, not an application quota.
    let nodeBudget = 500
    var index = 0
    var bytes = 0
    var truncated = false
    let deadline = Date().addingTimeInterval(1)
    while index < queue.count, elements.count < nodeBudget {
        let element = queue[index]
        index += 1
        guard visited.insert(element).inserted else { continue }
        if Date() >= deadline { truncated = true; break }
        AXUIElementSetMessagingTimeout(element, 0.2)
        var row: [String: Any] = ["element": elements.count]
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
        elements.append(element)
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        queue.append(contentsOf: children.prefix(max(0, nodeBudget - queue.count)))
    }
    return (rows, elements, truncated || index < queue.count || queue.count >= nodeBudget)
}
