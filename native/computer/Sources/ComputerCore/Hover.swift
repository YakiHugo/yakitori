import AppKit
import ApplicationServices

struct HoveredAlternate {
    let element: AXUIElement
    let window: WindowIdentity
}

extension Computer {
    func updateHover(_ target: InputTarget?, reveal: Bool) throws -> Bool {
        guard hovered != nil || reveal else { return false }
        var node = target?.element
        if node == nil, let point = target?.point, let window = target?.window {
            var hit: AXUIElement?
            if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(window.pid), Float(point.x), Float(point.y), &hit) == .success {
                node = hit
            }
        }
        var ancestors: [AXUIElement] = []
        var alternate: AXUIElement?
        while let current = node {
            // Bound malformed provider ancestry; ordinary controls need far fewer
            // parents and a cycle must not keep a native request alive forever.
            guard ancestors.count < 64, !ancestors.contains(where: { CFEqual($0, current) }) else {
                throw ComputerFailure("invalid_accessibility_tree", "Hover ancestry contains a cycle or exceeds the 64-parent traversal safety boundary.")
            }
            ancestors.append(current)
            if let hovered, target?.window?.pid == hovered.window.pid,
               target?.window?.windowID == hovered.window.windowID, CFEqual(current, hovered.element) { return true }
            let actions = accessibilityActions(current)
            if alternate == nil, actions.contains(kAXShowAlternateUIAction), actions.contains(kAXShowDefaultUIAction),
               attribute(current, kAXEnabledAttribute) as? Bool != false { alternate = current }
            if [kAXWindowRole, kAXApplicationRole, kAXSheetRole].contains(attribute(current, kAXRoleAttribute) as? String ?? "") { break }
            node = elementAttribute(current, kAXParentAttribute)
        }
        if let hovered {
            if processLaunchDate(hovered.window.pid) == hovered.window.launched {
                let error = AXUIElementPerformAction(hovered.element, kAXShowDefaultUIAction as CFString)
                guard error == .success || error == .invalidUIElement else {
                    throw ComputerFailure("hover_cleanup_failed", "Restoring the previous control's default UI was refused (\(error.rawValue)).")
                }
            }
            self.hovered = nil
        }
        guard reveal, let alternate, let window = target?.window else { return false }
        let error = AXUIElementPerformAction(alternate, kAXShowAlternateUIAction as CFString)
        guard error == .success else { throw ComputerFailure("action_refused", "Alternate hover UI was refused (\(error.rawValue)).") }
        hovered = HoveredAlternate(element: alternate, window: window)
        return true
    }
}
