import AppKit
import ApplicationServices

struct ObservationCondition {
    let fields: [String: String]
    let exists: Bool

    init(_ value: Any?) throws {
        let names = Set(["role", "title", "description", "value"])
        guard let object = value as? [String: Any],
              Set(object.keys).isSubset(of: names.union(["exists"])),
              object["exists"] == nil || object["exists"] is Bool else {
            throw ComputerFailure("invalid_arguments", "condition accepts exact role/title/description/value strings and optional exists boolean.")
        }
        let fields = object.filter { names.contains($0.key) }
        guard !fields.isEmpty, fields.values.allSatisfy({ $0 is String }) else {
            throw ComputerFailure("invalid_arguments", "condition requires at least one exact string field.")
        }
        self.fields = fields.mapValues { $0 as! String }
        exists = object["exists"] as? Bool ?? true
    }

    func evaluate(_ tree: AccessibilitySnapshot) -> String {
        // Missing nodes or shortened field values cannot establish an exact
        // match, uniqueness, or absence. Never turn an incomplete read into success.
        if tree.truncated { return "unavailable" }
        let matches = tree.rows.filter { row in fields.allSatisfy { row[$0.key] as? String == $0.value } }.count
        if !exists { return matches == 0 ? "matched" : "pending" }
        if matches > 1 { return "ambiguous" }
        return matches == 1 ? "matched" : "pending"
    }
}

extension Computer {
    private func queryTarget(_ args: [String: Any]) throws -> Snapshot {
        guard let snapshot else { throw ComputerFailure("stale_snapshot", "Observe before querying or waiting.") }
        try snapshot.validate(id: args["snapshot_id"] as? String, windows: windows(), displays: displays())
        guard snapshot.tree != nil else {
            throw ComputerFailure("accessibility_unavailable", "Use an AX/both observation with Accessibility before querying or waiting.")
        }
        return snapshot
    }

    func querySnapshot(_ args: [String: Any]) throws -> [String: Any] {
        let target = try queryTarget(args)
        guard let tree = target.tree else { preconditionFailure("queryTarget requires an AX tree") }
        guard args["query"] == nil || args["query"] is String,
              let offset = args["offset"] as? Int ?? (args["offset"] == nil ? 0 : nil), offset >= 0,
              let limit = args["limit"] as? Int ?? (args["limit"] == nil ? 50 : nil), limit > 0, limit <= 500 else {
            throw ComputerFailure("invalid_arguments", "query is literal text; offset is nonnegative; limit is 1...500 (the AX node memory boundary).")
        }
        let query = args["query"] as? String ?? ""
        let matches = tree.rows.filter { row in
            query.isEmpty || ["role", "title", "description", "value"].contains { key in
                (row[key] as? String)?.range(of: query, options: [.caseInsensitive, .literal]) != nil
            }
        }
        let page = Array(matches.dropFirst(min(offset, matches.count)).prefix(limit))
        var data: [String: Any] = ["snapshot_id": target.id, "elements": page, "total": matches.count,
            "tree_truncated": tree.truncated, "cached": true]
        if offset < matches.count, page.count < matches.count - offset { data["next_offset"] = offset + page.count }
        return try result(data)
    }

    func waitForObservation(_ action: String, _ args: [String: Any]) async throws -> [String: Any] {
        let target = try queryTarget(args)
        guard let previous = target.tree else { preconditionFailure("queryTarget requires an AX tree") }
        guard AXIsProcessTrusted() else { throw ComputerFailure("permission_required", "Waiting requires Accessibility.") }
        // One MCP connection serializes actions. Bound the time a wait can own
        // that queue; this is a host responsiveness boundary, not a product quota.
        guard let timeout = args["timeout_seconds"] as? Double ?? (args["timeout_seconds"] == nil ? 5 : nil),
              timeout.isFinite, timeout >= 0, timeout <= 30 else {
            throw ComputerFailure("invalid_arguments", "timeout_seconds must be between 0 and 30.")
        }
        let condition = action == "wait_for" ? try ObservationCondition(args["condition"]) : nil
        if action == "wait_for_change", args["condition"] != nil {
            throw ComputerFailure("invalid_arguments", "wait_for_change compares AX observations and does not accept condition.")
        }
        var request: [String: Any] = ["scope": target.scope.rawValue, "mode": "ax"]
        if let display = target.display { request["display_id"] = Int(display.id) }
        else if let window = target.windows.first {
            request["pid"] = Int(window.pid)
            if target.scope == .window { request["window_id"] = Int(window.windowID) }
        }
        let baseline = try JSONSerialization.data(withJSONObject: previous.rows, options: [.sortedKeys])
        let started = ProcessInfo.processInfo.systemUptime
        var published = false
        // Cancellation or a failed poll must not leave an unpublished ticket
        // usable after the caller has already abandoned this wait.
        defer { if !published { snapshot = nil } }
        while true {
            try Task.checkCancellation()
            if let window = target.windows.first, target.scope != .screen {
                guard let running = NSRunningApplication(processIdentifier: window.pid), running.launchDate == window.launched else {
                    throw ComputerFailure("stale_snapshot", "The observed application exited or restarted.")
                }
            }
            let response = try await observe(request)
            guard let fresh = snapshot, var data = response["structuredContent"] as? [String: Any] else {
                preconditionFailure("Observation must publish its snapshot and structured content")
            }
            guard let tree = fresh.tree else {
                throw ComputerFailure("accessibility_unavailable", "Accessibility became unavailable during the wait.")
            }
            let status: String
            if let condition { status = condition.evaluate(tree) }
            else if previous.truncated || tree.truncated { status = "unavailable" }
            else {
                let current = try JSONSerialization.data(withJSONObject: tree.rows, options: [.sortedKeys])
                status = baseline != current || target.windows != fresh.windows || target.display != fresh.display ? "changed" : "pending"
            }
            try Task.checkCancellation()
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            if status != "pending" || elapsed >= timeout {
                data["wait_status"] = status == "pending" ? "timed_out" : status
                data["elapsed_seconds"] = elapsed
                let result = try result(data)
                published = true
                return result
            }
            try await Task.sleep(for: .seconds(min(0.15, timeout - elapsed)))
        }
    }
}
