import Foundation

// Bound model-facing AX text separately from the structured snapshot, which is
// retained for query and input. Keep truncation notices inside the same budget.
private let observationTextSafetyBytes = 24 * 1024

func renderObservationText(_ data: inout [String: Any]) throws -> String? {
    guard let snapshotID = data["snapshot_id"] as? String,
          data["elements"] != nil || data["diff"] != nil else { return nil }
    let fields = ["scope", "mode", "pid", "launch_time", "window_id", "display_id", "image_width", "image_height", "frame",
                  "tree_truncated", "accessibility_error", "input_available", "total_matches", "next_offset", "matched", "changed", "timed_out"]
    let diff = data["diff"] as? [String: Any]
    let start = diff == nil ? "<ax-tree data-only=\"true\">" : "<ax-diff data-only=\"true\">"
    let end = diff == nil ? "</ax-tree>" : "</ax-diff>"
    let clipped = "AX output is incomplete; use query with this snapshot_id or observe a root_element."
    let headerBudget = 4 * 1024
    let bodyBudget = observationTextSafetyBytes - headerBudget - start.utf8.count - end.utf8.count - clipped.utf8.count - 4
    var body = "", bodyBytes = 0
    var presentationTruncated = false
    var renderedRows = 0
    var depths: [Int: Int] = [:]

    func append(_ line: String) -> Bool {
        let bytes = line.utf8.count + 1
        guard bodyBytes + bytes <= bodyBudget else { presentationTruncated = true; return false }
        body += line + "\n"
        bodyBytes += bytes
        return true
    }

    func appendRows(_ rows: [[String: Any]], prefix: String = "") throws {
        for row in rows {
            guard let index = row["element"] as? Int else { continue }
            let depth = row["parent"].flatMap { $0 as? Int }.map { (depths[$0] ?? 0) + 1 } ?? 0
            depths[index] = depth
            var line = String(repeating: "  ", count: min(depth, 24)) + "\(prefix)[\(index)]"
            if let role = row["role"] as? String {
                let token = role.utf8.count <= 64 && role.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) }
                line += " " + (token ? role : try axTextLiteral(role))
            }
            for (key, label) in [("title", ""), ("description", "description="), ("value", "value="), ("identifier", "id="),
                                 ("placeholder", "placeholder="), ("subrole", "subrole="), ("role_description", "role_description="),
                                 ("help", "help="), ("url", "url=")] {
                if let value = row[key], !(value as? String == "") { line += " " + label + (try axTextLiteral(value)) }
            }
            if let frame = row["frame"] as? [String: Double] {
                let coordinates = ["x", "y", "width", "height"].compactMap { frame[$0] }.map { String(format: "%.1f", $0) }
                line += " (\(coordinates.joined(separator: ",")))"
            }
            if let actions = row["actions"] as? [String], !actions.isEmpty {
                line += " actions=[" + (try actions.prefix(16).map { try axTextLiteral($0, scalarLimit: 64) }).joined(separator: ",") + "]"
            }
            var flags = ["focused", "enabled", "selected", "expanded"].filter { row[$0] as? Bool == true }
            if row["enabled"] as? Bool == false { flags.append("disabled") }
            if let incomplete = row["children_incomplete"] as? String { flags.append("children_incomplete=\(incomplete)") }
            if let errors = row["unreadable_attributes"] as? [String], !errors.isEmpty { flags.append("unreadable=\(errors.joined(separator: ","))") }
            if !flags.isEmpty { line += " [\(flags.joined(separator: ","))]" }
            if !append(line) { break }
            renderedRows += 1
        }
    }

    if let diff {
        if let base = diff["base_snapshot_id"] as? String { _ = append("base_snapshot_id: \(base)") }
        if let complete = diff["complete"] as? Bool { _ = append("complete: \(complete)") }
        try appendRows(diff["added"] as? [[String: Any]] ?? [], prefix: "+ ")
        if !presentationTruncated { try appendRows(diff["updated"] as? [[String: Any]] ?? [], prefix: "~ ") }
        if !presentationTruncated, let removed = diff["removed"] as? [Int], !removed.isEmpty {
            _ = append("removed: " + removed.map(String.init).joined(separator: ", "))
        }
    } else {
        let rows = data["elements"] as? [[String: Any]] ?? []
        try appendRows(data["total_matches"] != nil ? rows : hierarchicalAXRows(rows))
        if presentationTruncated, let total = data["total_matches"] as? Int {
            data["next_offset"] = (data["next_offset"] as? Int ?? total) - rows.count + renderedRows
            data["elements"] = Array(rows.prefix(renderedRows))
        }
    }
    if presentationTruncated { data["tree_truncated"] = true }
    var header = "snapshot_id: \(snapshotID)\n"
    for field in fields {
        if let value = data[field] { header += "\(field): \(try axTextLiteral(value))\n" }
    }
    let notice = data["tree_truncated"] as? Bool == true ? "\n" + clipped : ""
    return header + start + "\n" + body + end + notice
}

func hierarchicalAXRows(_ rows: [[String: Any]]) -> [[String: Any]] {
    let indices = Set(rows.compactMap { $0["element"] as? Int })
    let branches = Dictionary(grouping: rows) { row in
        (row["parent"] as? Int).flatMap { indices.contains($0) ? $0 : nil }
    }
    var pending = Array((branches[nil] ?? []).reversed())
    var result: [[String: Any]] = []
    while let row = pending.popLast() {
        result.append(row)
        if let index = row["element"] as? Int, let children = branches[index] {
            pending.append(contentsOf: children.reversed())
        }
    }
    return result
}

private func axTextLiteral(_ value: Any, scalarLimit: Int = 192) throws -> String {
    let bounded = (value as? String).map { text in
        let sample = text.unicodeScalars.prefix(scalarLimit + 1)
        return sample.count > scalarLimit ? String(sample.prefix(scalarLimit)) + "…" : text
    } as Any? ?? value
    return String(decoding: try JSONSerialization.data(withJSONObject: bounded, options: [.fragmentsAllowed, .sortedKeys]), as: UTF8.self)
        .replacingOccurrences(of: "<", with: "\\u003c")
        .replacingOccurrences(of: ">", with: "\\u003e")
        .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
        .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
}
