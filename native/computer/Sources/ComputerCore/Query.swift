import Foundation
import ApplicationServices

struct AXExpectation {
    let fields: [String: String]
    let exists: Bool

    init(_ value: Any?) throws {
        guard let object = value as? [String: Any], !object.isEmpty,
              Set(object.keys).isSubset(of: ["role", "title", "description", "value", "exists"]),
              object["exists"] == nil || object["exists"] is Bool else {
            throw ComputerFailure("invalid_arguments", "expect requires exact role/title/description/value criteria and optional exists.")
        }
        var fields: [String: String] = [:]
        for key in ["role", "title", "description", "value"] where object[key] != nil {
            guard let text = object[key] as? String else { throw ComputerFailure("invalid_arguments", "AX criteria must be strings.") }
            fields[key] = text
        }
        guard !fields.isEmpty else { throw ComputerFailure("invalid_arguments", "At least one AX criterion is required.") }
        self.fields = fields
        exists = object["exists"] as? Bool ?? true
    }

    func matches(_ row: [String: Any]) -> Bool {
        fields.allSatisfy { key, value in
            if (row["truncated_attributes"] as? [String] ?? []).contains(key) { return false }
            if let actual = row[key] as? String { return actual == value }
            if let actual = row[key] as? NSNumber { return actual.stringValue == value }
            return false
        }
    }

    func satisfied(by snapshot: Snapshot) -> Bool {
        let found = snapshot.rows.contains(where: matches)
        // Missing nodes in a bounded tree do not prove absence from the app.
        let incomplete = snapshot.rows.contains { row in
            !(Set(row["truncated_attributes"] as? [String] ?? []).intersection(fields.keys)).isEmpty
        }
        return exists ? found : !found && !snapshot.truncated && !incomplete
    }
}

extension Snapshot {
    func observationArguments(mode: String = "ax") -> [String: Any] {
        var args: [String: Any] = ["action": "observe", "scope": scope.rawValue, "mode": mode, "disable_diff": true]
        if scope == .screen { args["display_id"] = display.map { Int($0.id) } }
        else { args["pid"] = windows.first.map { Int($0.pid) } }
        if scope == .window { args["window_id"] = windows.first.map { Int($0.windowID) } }
        return args
    }

    func difference(from previous: Snapshot) -> [String: Any] {
        var added: [[String: Any]] = [], updated: [[String: Any]] = []
        var retained = Set<Int>()
        for (index, element) in elements.enumerated() {
            guard let old = previous.elements.firstIndex(where: { $0.window.windowID == element.window.windowID && CFEqual($0.value, element.value) }) else {
                added.append(rows[index]); continue
            }
            retained.insert(old)
            var before = previous.rows[old], after = rows[index]
            // Array indices/parent indices are local to their snapshot. Compare
            // attributes by AX identity, never by labels or a shifted position.
            before.removeValue(forKey: "element"); before.removeValue(forKey: "parent")
            after.removeValue(forKey: "element"); after.removeValue(forKey: "parent")
            if !NSDictionary(dictionary: before).isEqual(to: after) { updated.append(rows[index]) }
        }
        return ["base_snapshot_id": previous.id, "added": added, "updated": updated,
            "removed": previous.elements.indices.filter { !retained.contains($0) },
            "complete": !truncated && !previous.truncated]
    }
}

extension Computer {
    func query(_ args: [String: Any]) throws -> [String: Any] {
        guard let stored = lastObservation, stored.id == args["snapshot_id"] as? String else {
            throw ComputerFailure("stale_snapshot", "query requires the last stored snapshot_id; it never restores a consumed input ticket.")
        }
        let offset = args["offset"] as? Int ?? 0, limit = args["limit"] as? Int ?? 100
        guard offset >= 0, (1...500).contains(limit),
              args["offset"] == nil || args["offset"] is Int, args["limit"] == nil || args["limit"] is Int,
              args["query"] == nil || args["query"] is String else {
            throw ComputerFailure("invalid_arguments", "offset must be nonnegative and limit within the 500-node snapshot memory boundary.")
        }
        let query = (args["query"] as? String ?? "").lowercased()
        var included: Set<Int>?
        if args["root_element"] != nil {
            guard let root = args["root_element"] as? Int, stored.elements.indices.contains(root) else {
                throw ComputerFailure("invalid_element", "root_element must belong to the stored snapshot.")
            }
            var descendants = Set([root])
            for row in stored.rows {
                if let parent = row["parent"] as? Int, descendants.contains(parent), let child = row["element"] as? Int { descendants.insert(child) }
            }
            included = descendants
        }
        let matches = stored.rows.filter { row in
            (included == nil || included!.contains(row["element"] as? Int ?? -1)) &&
                (query.isEmpty || ["role", "title", "description", "value"].contains { key in
                    (row[key].map { String(describing: $0).lowercased() } ?? "").contains(query)
                })
        }
        let page = Array(matches.dropFirst(offset).prefix(limit))
        var data: [String: Any] = ["snapshot_id": stored.id, "elements": page, "total_matches": matches.count,
            "tree_truncated": stored.truncated, "input_available": snapshot?.id == stored.id]
        if offset + page.count < matches.count { data["next_offset"] = offset + page.count }
        return try result(data)
    }
}
