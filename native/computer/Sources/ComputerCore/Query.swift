import Foundation
import ApplicationServices

private func unknownAXFields(_ row: [String: Any]) -> Set<String> {
    Set((row["truncated_attributes"] as? [String] ?? []) + (row["unreadable_attributes"] as? [String] ?? []))
}

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
        let unknown = unknownAXFields(row)
        return fields.allSatisfy { key, value in
            !unknown.contains(key) && text(row[key]) == value
        }
    }

    private func text(_ value: Any?) -> String? {
        (value as? String) ?? (value as? NSNumber)?.stringValue
    }

    func coverageIncomplete(in snapshot: Snapshot) -> Bool {
        snapshot.incompleteRoots || snapshot.rows.contains { row in
            if row["children_incomplete"] != nil { return true }
            let unknown = unknownAXFields(row)
            return fields.keys.contains(where: unknown.contains) && fields.allSatisfy { key, expected in
                unknown.contains(key) || text(row[key]) == expected
            }
        }
    }

    func satisfied(by snapshot: Snapshot) -> Bool {
        let found = snapshot.rows.contains(where: matches)
        return exists ? found : !found && !coverageIncomplete(in: snapshot)
    }
}

extension Snapshot {
    func changesSinceInput(_ previous: Snapshot, diff: [String: Any]? = nil) -> [String: Any] {
        guard isFullWindow, previous.isFullWindow, windows == previous.windows else { return [:] }
        var receipt: [String: Any] = [:]
        if hasWindowAX, previous.hasWindowAX {
            let changes = diff ?? difference(from: previous, verifiedChangesOnly: true)
            if let added = changes["added"] as? [[String: Any]], let updated = changes["updated"] as? [[String: Any]],
               let removed = changes["removed"] as? [Int] {
                let changed = !added.isEmpty || !updated.isEmpty || !removed.isEmpty
                if changed || changes["complete"] as? Bool == true { receipt["ax_changed"] = changed }
            }
        }
        if let visualFingerprint, let before = previous.visualFingerprint {
            receipt["visual_changed"] = visualFingerprint != before
        }
        if receipt["ax_changed"] as? Bool == false, receipt["visual_changed"] as? Bool == false {
            receipt["no_effect"] = true
        }
        return receipt
    }

    func observationArguments(mode: String = "ax") -> [String: Any] {
        var args: [String: Any] = ["action": "observe", "scope": scope.rawValue, "mode": mode]
        if scope == .screen { args["display_id"] = display.map { Int($0.id) } }
        else { args["pid"] = windows.first.map { Int($0.pid) } }
        if scope == .window { args["window_id"] = windows.first.map { Int($0.windowID) } }
        return args
    }

    func difference(from previous: Snapshot, verifiedChangesOnly: Bool = false) -> [String: Any] {
        var added: [[String: Any]] = [], updated: [[String: Any]] = []
        var retained = Set<Int>()
        let complete = !truncated && !previous.truncated
        let compareKnownFields = verifiedChangesOnly && !complete
        // An unreadable attribute need not prevent a known value change, but
        // a missing branch makes adding/removing a node ambiguous.
        let compareMembership = !compareKnownFields || (!incompleteRoots && !previous.incompleteRoots &&
            !rows.contains { $0["children_incomplete"] != nil } &&
            !previous.rows.contains { $0["children_incomplete"] != nil })
        for (index, element) in elements.enumerated() {
            guard let old = previous.elements.firstIndex(where: { $0.window.windowID == element.window.windowID && CFEqual($0.value, element.value) }) else {
                if compareMembership { added.append(rows[index]) }
                continue
            }
            retained.insert(old)
            var before = previous.rows[old], after = rows[index]
            // Array indices/parent indices are local to their snapshot. Compare
            // attributes by AX identity, never by labels or a shifted position.
            before.removeValue(forKey: "element"); before.removeValue(forKey: "parent")
            after.removeValue(forKey: "element"); after.removeValue(forKey: "parent")
            if compareKnownFields {
                let known = Set(before.keys).intersection(after.keys)
                    .subtracting(unknownAXFields(before)).subtracting(unknownAXFields(after))
                    .subtracting(["unreadable_attributes", "truncated_attributes", "children_incomplete"])
                before = before.filter { known.contains($0.key) }
                after = after.filter { known.contains($0.key) }
            }
            if !NSDictionary(dictionary: before).isEqual(to: after) { updated.append(rows[index]) }
        }
        return ["base_snapshot_id": previous.id, "added": added, "updated": updated,
            "removed": compareMembership ? previous.elements.indices.filter { !retained.contains($0) } : [],
            "complete": complete]
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
        let scopeRows = stored.rows.filter { row in included?.contains(row["element"] as? Int ?? -1) ?? true }
        let matches = hierarchicalAXRows(scopeRows).filter { row in
            query.isEmpty || ["role", "title", "description", "value", "identifier", "placeholder", "help", "url"].contains { key in
                    (row[key].map { String(describing: $0).lowercased() } ?? "").contains(query)
                }
        }
        let page = Array(matches.dropFirst(offset).prefix(limit))
        var data: [String: Any] = ["snapshot_id": stored.id, "elements": page, "total_matches": matches.count,
            "tree_truncated": (included == nil && stored.incompleteRoots) || scopeRows.contains(where: isIncompleteAXRow),
            "input_available": snapshot?.id == stored.id]
        if offset + page.count < matches.count { data["next_offset"] = offset + page.count }
        return try result(data)
    }
}
