import AppKit

enum ApplicationTarget {
    case bundleID(String), path(String), name(String)

    init(_ args: [String: Any]) throws {
        let fields = ["bundle_id", "app_path", "app_name"].filter { args[$0] != nil }
        guard fields.count == 1, let field = fields.first,
              let value = args[field] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ComputerFailure("invalid_arguments", "Launch requires exactly one nonempty bundle_id, app_path, or app_name.")
        }
        switch field {
        case "bundle_id": self = .bundleID(value)
        case "app_path": self = .path(value)
        default:
            guard !value.contains("/") else { throw ComputerFailure("invalid_arguments", "Use app_path for an absolute .app path.") }
            self = .name(value)
        }
    }
}

func applicationURL(_ target: ApplicationTarget, roots: [URL], running: [URL]) throws -> URL {
    let url: URL
    switch target {
    case .bundleID(let id):
        let active = Set(running.filter { Bundle(url: $0)?.bundleIdentifier?.caseInsensitiveCompare(id) == .orderedSame }
            .map { $0.resolvingSymlinksInPath().standardizedFileURL })
        guard active.count <= 1 else {
            throw ComputerFailure("app_ambiguous", "Multiple running applications have bundle_id \(id); use app_path.")
        }
        guard let installed = active.first ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
            throw ComputerFailure("app_not_found", "No installed application has bundle_id \(id).")
        }
        url = installed
    case .path(let path):
        guard NSString(string: path).isAbsolutePath else {
            throw ComputerFailure("invalid_arguments", "app_path must be an absolute .app path.")
        }
        url = URL(fileURLWithPath: path)
    case .name(let name):
        let expected = name.hasSuffix(".app") ? String(name.dropLast(4)) : name
        var candidates = running
        // Search application directories without descending into bundles. Exact
        // names keep a partial match from unexpectedly launching another app.
        for root in roots where FileManager.default.fileExists(atPath: root.path) {
            var searchError: Error?
            guard let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles, .skipsPackageDescendants], errorHandler: { _, error in
                    searchError = error
                    return false
                }) else { throw ComputerFailure("application_search_failed", "Could not search \(root.path).") }
            for case let entry as URL in entries where entry.pathExtension == "app" { candidates.append(entry) }
            if let searchError { throw searchError }
        }
        let matches = Set(candidates.filter { candidate in
            let bundle = Bundle(url: candidate)
            let displayName = bundle?.localizedInfoDictionary?["CFBundleDisplayName"] as? String
                ?? bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            return candidate.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(expected) == .orderedSame
                || displayName?.caseInsensitiveCompare(name) == .orderedSame
        }.map { $0.resolvingSymlinksInPath().standardizedFileURL }).sorted { $0.path < $1.path }
        guard matches.count == 1, let match = matches.first else {
            throw ComputerFailure(matches.isEmpty ? "app_not_found" : "app_ambiguous",
                matches.isEmpty ? "No application named \(name) was found. Use bundle_id or app_path for other install locations."
                    : "Multiple applications match \(name); use app_path: \(matches.map(\.path).joined(separator: ", "))")
        }
        url = match
    }
    let canonical = url.resolvingSymlinksInPath().standardizedFileURL
    guard canonical.pathExtension == "app", let bundle = Bundle(url: canonical), bundle.executableURL != nil else {
        throw ComputerFailure("app_not_found", "The target must be an application bundle with an executable: \(canonical.path)")
    }
    return canonical
}

extension Computer {
    func launch(_ args: [String: Any]) async throws -> [String: Any] {
        let url = try applicationURL(ApplicationTarget(args), roots: [
            "/Applications", "/System/Applications", "/System/Library/CoreServices", NSHomeDirectory() + "/Applications",
        ].map { URL(fileURLWithPath: $0) }, running: NSWorkspace.shared.runningApplications.compactMap(\.bundleURL))
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        // LaunchServices may finish after cancellation. Drain the tool promptly
        // without replaying launch; a fresh list can discover the late result.
        let app: NSRunningApplication = try await nativeRequest { done in
            NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
                if let error { done(.failure(error)) }
                else if let app { done(.success(app)) }
                else { done(.failure(ComputerFailure("launch_failed", "LaunchServices returned no application."))) }
            }
        }
        try Task.checkCancellation()
        return try result(["pid": app.processIdentifier, "app_path": url.path, "bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""])
    }
}
