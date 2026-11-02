import ApplicationServices
import Foundation

func snapshotCompletenessContracts() throws {
    // Inject only the native attribute transport, not the traversal/classifier
    // or its consumers. These synthetic elements never post input or need TCC.
    let root = AXUIElementCreateApplication(100000001)
    let match = AXUIElementCreateApplication(100000002)
    let branch = AXUIElementCreateApplication(100000003)
    let hidden = AXUIElementCreateApplication(100000004)
    let window = WindowIdentity(pid: 100000001, launched: nil, windowID: 7,
        frame: CGRect(x: 0, y: 0, width: 400, height: 200), layer: 0)
    func observe(attribute name: String = kAXChildrenAttribute, status: AXError, value: CFTypeRef?) -> Snapshot {
        let tree = accessibilityTree([(window, root)], deadline: .distantFuture) { element, attribute, output in
            let attribute = attribute as String
            if CFEqual(element, branch) && attribute == name {
                output.pointee = value
                return status
            }
            if attribute == kAXChildrenAttribute {
                output.pointee = CFEqual(element, root) ? [match, branch] as CFArray : [] as CFArray
                return .success
            }
            if attribute == kAXRoleAttribute {
                output.pointee = (CFEqual(element, match) || CFEqual(element, hidden) ? kAXButtonRole : kAXGroupRole) as CFString
                return .success
            }
            if attribute == kAXTitleAttribute && (CFEqual(element, match) || CFEqual(element, hidden)) {
                output.pointee = "Save" as CFString
                return .success
            }
            return .noValue
        }
        return Snapshot(scope: .window, frame: window.frame, windows: [window], display: nil,
            imageWidth: nil, imageHeight: nil, elements: tree.elements, rows: tree.rows, truncated: tree.truncated)
    }
    let absent = try AXExpectation(["title": "Missing", "exists": false])
    let present = try AXExpectation(["title": "Save"])
    let complete = observe(status: .success, value: [] as CFArray)
    precondition(!complete.truncated && complete.rows.count == 3)
    precondition(absent.satisfied(by: complete) && present.satisfied(by: complete))
    let target = try complete.target(["selector": ["title": "Save"]])
    precondition(CFEqual(target.element!, match))
    precondition(complete.difference(from: complete)["complete"] as? Bool == true)

    // Empty/unsupported attributes remain valid leaves, not partial trees.
    for status: AXError in [.noValue, .attributeUnsupported] {
        let leaf = observe(status: status, value: nil)
        precondition(!leaf.truncated && leaf.rows.count == 3 && absent.satisfied(by: leaf))
        _ = try leaf.target(["selector": ["title": "Save"]])
    }
    let duplicate = observe(status: .success, value: [hidden] as CFArray)
    precondition(!duplicate.truncated && duplicate.rows.count == 4)
    precondition(duplicate.rows[3]["parent"] as? Int == 2)
    Contracts.rejects(code: "ambiguous_element") { _ = try duplicate.target(["selector": ["title": "Save"]]) }

    func refusesProofs(_ partial: Snapshot) throws {
        precondition(partial.truncated && partial.rows.count == 3)
        precondition(!absent.satisfied(by: partial) && present.satisfied(by: partial))
        Contracts.rejects(code: "tree_truncated") { _ = try partial.target(["selector": ["title": "Save"]]) }
        // An explicit observed index still works; incomplete does not mean no
        // evidence is usable or that the observer should discard readable rows.
        let explicit = try partial.target(["element": 1])
        precondition(CFEqual(explicit.element!, match))
        precondition(partial.difference(from: complete)["complete"] as? Bool == false)
        precondition(complete.difference(from: partial)["complete"] as? Bool == false)
    }
    for status: AXError in [.cannotComplete, .invalidUIElement, .apiDisabled, .notImplemented, .failure, .illegalArgument] {
        try refusesProofs(observe(status: status, value: nil))
    }
    // Malformed successes must not silently become an empty child array.
    for value: CFTypeRef? in [nil, "not an array" as CFString, ([match, "not an element" as CFString] as [AnyObject]) as CFArray] {
        try refusesProofs(observe(status: .success, value: value))
    }
    // A hidden selector field can conceal another match even when all child
    // arrays are readable, so that boundary must also invalidate completeness.
    for attribute in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        try refusesProofs(observe(attribute: attribute, status: .cannotComplete, value: nil))
        try refusesProofs(observe(attribute: attribute, status: .success, value: nil))
        for status: AXError in [.noValue, .attributeUnsupported] {
            precondition(!observe(attribute: attribute, status: status, value: nil).truncated)
        }
    }
    for attribute in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
        try refusesProofs(observe(attribute: attribute, status: .success, value: [] as CFArray))
    }
    print("Native AX read failures cannot prove selector uniqueness, absence or complete diffs; valid leaves and explicit indices remain usable.")
}
