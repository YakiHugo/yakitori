import AppKit
import ApplicationServices

func menuPath(_ value: Any?) throws -> [String] {
    // Bound native menu expansion and AX messaging within one input operation.
    guard let path = value as? [String], (1...16).contains(path.count),
          path.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
        throw ComputerFailure("invalid_arguments", "invoke_menu requires 1...16 nonempty exact menu labels in path.")
    }
    return path
}

func accessibilityActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(element, &names) == .success ? names as? [String] ?? [] : []
}

func pasteMenuItem(_ window: WindowIdentity) throws -> AXUIElement? {
    guard let root = elementAttribute(AXUIElementCreateApplication(window.pid), kAXMenuBarAttribute) else { return nil }
    // Use the existing AX observation work boundary. An incomplete lookup must
    // not claim uniqueness; choose the keyboard route before issuing any write.
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    var queue = [root], visited = Set<AXUIElement>(), matches: [AXUIElement] = []
    var index = 0
    func read(_ node: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
        AXUIElementSetMessagingTimeout(node, 0.2)
        var value: CFTypeRef?
        return (AXUIElementCopyAttributeValue(node, name as CFString, &value), value)
    }
    while index < queue.count {
        try Task.checkCancellation()
        guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
        let node = queue[index]; index += 1
        guard visited.insert(node).inserted else { continue }
        let (keyError, key) = read(node, kAXMenuItemCmdCharAttribute)
        guard [.success, .attributeUnsupported, .noValue].contains(keyError) else { return nil }
        guard keyError != .success || key is String else { return nil }
        if (key as? String)?.lowercased() == "v" {
            let (modifierError, modifiers) = read(node, kAXMenuItemCmdModifiersAttribute)
            guard modifierError == .success, let modifiers = modifiers as? NSNumber else { return nil }
            // AX menu modifiers omit Command by default; zero is exactly Cmd-V.
            let (enabledError, enabled) = read(node, kAXEnabledAttribute)
            guard enabledError == .success, let enabled = enabled as? Bool else { return nil }
            if modifiers.doubleValue == 0, enabled {
                matches.append(node)
                if matches.count > 1 { return nil }
            }
        }
        let (childrenError, value) = read(node, kAXChildrenAttribute)
        guard [.success, .attributeUnsupported, .noValue].contains(childrenError) else { return nil }
        guard childrenError != .success || value is [AXUIElement] else { return nil }
        let children = value as? [AXUIElement] ?? []
        guard queue.count + children.count <= 500 else { return nil }
        queue.append(contentsOf: children)
    }
    guard let item = matches.first, accessibilityActions(item).contains(kAXPressAction) else { return nil }
    return item
}

@MainActor func invokeMenu(_ path: [String], window: WindowIdentity) async throws -> [String: Any] {
    let application = AXUIElementCreateApplication(window.pid)
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    var expanded: [String] = []
    var opened: [AXUIElement] = []

    func resolve(_ prefix: [String]) throws -> AXUIElement? {
        guard var node = elementAttribute(application, kAXMenuBarAttribute) else {
            throw ComputerFailure("menu_unavailable", "The application does not expose an accessible menu bar.")
        }
        for label in prefix {
            let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
            let entries = children.flatMap { child -> [AXUIElement] in
                if attribute(child, kAXRoleAttribute) as? String == kAXMenuRole {
                    return attribute(child, kAXChildrenAttribute) as? [AXUIElement] ?? []
                }
                return [child]
            }
            let matches = entries.filter { attribute($0, kAXTitleAttribute) as? String == label }
            guard matches.count <= 1 else { throw ComputerFailure("menu_ambiguous", "The menu label \(label) matches multiple siblings.") }
            guard let next = matches.first else { return nil }
            guard [kAXMenuBarItemRole, kAXMenuItemRole].contains(attribute(next, kAXRoleAttribute) as? String ?? "") else {
                throw ComputerFailure("menu_structure_changed", "The menu path no longer names native menu items.")
            }
            guard attribute(next, kAXEnabledAttribute) as? Bool != false else { throw ComputerFailure("menu_disabled", "The menu item \(label) is disabled.") }
            node = next
        }
        return node
    }

    func closeMenus() -> [Int32] {
        opened.reversed().compactMap { node in
            guard accessibilityActions(node).contains(kAXCancelAction) else { return nil }
            let error = AXUIElementPerformAction(node, kAXCancelAction as CFString)
            return error == .success || error == .invalidUIElement ? nil : error.rawValue
        }
    }

    do {
        for index in path.indices {
            try Task.checkCancellation()
            guard processLaunchDate(window.pid) == window.launched else {
                throw ComputerFailure("stale_snapshot", "The menu target process exited or restarted.")
            }
            let prefix = Array(path.prefix(index + 1))
            var item = try resolve(prefix)
            // Expand each parent once; only re-read while its children publish.
            while item == nil && !expanded.isEmpty && ProcessInfo.processInfo.systemUptime < deadline {
                try await Task.sleep(nanoseconds: 20_000_000)
                item = try resolve(prefix)
            }
            guard let item else { throw ComputerFailure("menu_not_found", "The exact menu path is not currently exposed.") }
            let actions = accessibilityActions(item)
            let action = index < path.count - 1 && actions.contains(kAXShowMenuAction) ? kAXShowMenuAction : kAXPressAction
            guard actions.contains(action) else { throw ComputerFailure("action_refused", "The menu item does not expose the requested native action.") }
            let error = AXUIElementPerformAction(item, action as CFString)
            guard error == .success else { throw ComputerFailure("action_refused", "The menu action was refused (\(error.rawValue)).") }
            if index < path.count - 1 {
                expanded = prefix
                opened.append(item)
                opened.append(contentsOf: (attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
                    attribute($0, kAXRoleAttribute) as? String == kAXMenuRole
                })
            }
        }
        return ["menu_path": path, "cleanup_errors": closeMenus()]
    } catch {
        let failure = error as? ComputerFailure
        throw ComputerFailure(error is CancellationError ? "cancelled" : failure?.code ?? "menu_failed",
            failure?.message ?? error.localizedDescription,
            evidence: ["expanded_path": expanded, "cleanup_errors": closeMenus(), "effect": "unverified"])
    }
}
