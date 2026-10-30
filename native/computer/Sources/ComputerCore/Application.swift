import AppKit
import CryptoKit

struct ApplicationLaunchOptions {
    let arguments: [String]
    let urls: [URL]
    let newInstance: Bool
    let foreground: Bool

    init(_ args: [String: Any]) throws {
        if let value = args["new_instance"] {
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw ComputerFailure("invalid_arguments", "new_instance must be a boolean.")
            }
            newInstance = number.boolValue
        } else { newInstance = false }
        let delivery = args["delivery"] as? String ?? "background"
        guard ["background", "foreground"].contains(delivery), args["delivery"] == nil || args["delivery"] is String else {
            throw ComputerFailure("invalid_arguments", "Launch delivery must be background or foreground.")
        }
        foreground = delivery == "foreground"
        func strings(_ key: String) throws -> [String] {
            guard let value = args[key] else { return [] }
            // Bound native launch/Apple-event payload allocation to 64 KiB and
            // 128 entries; arguments are passed literally, never through a shell.
            guard let values = value as? [String], values.count <= 128,
                  values.reduce(0, { $0 + $1.utf8.count }) <= 64 * 1024,
                  !values.contains(where: { $0.contains("\0") }) else {
                throw ComputerFailure("invalid_arguments", "\(key) must be a string array within the 128-entry/64 KiB native launch payload boundary, without NUL bytes.")
            }
            return values
        }
        arguments = try strings("arguments")
        urls = try strings("open_urls").map { value in
            guard !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  let url = URL(string: value, encodingInvalidCharacters: false), let scheme = url.scheme, !scheme.isEmpty else {
                throw ComputerFailure("invalid_arguments", "open_urls requires absolute URLs, including file:// URLs for documents.")
            }
            return url
        }
    }
}

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
        let options = try ApplicationLaunchOptions(args)
        let url = try applicationURL(ApplicationTarget(args), roots: [
            "/Applications", "/System/Applications", "/System/Library/CoreServices", NSHomeDirectory() + "/Applications",
        ].map { URL(fileURLWithPath: $0) }, running: NSWorkspace.shared.runningApplications.compactMap(\.bundleURL))
        let key = SHA256.hash(data: Data(url.path.utf8)).map { String(format: "%02x", $0) }.joined()
        let launchResource = try await NativeResources.acquire(["launch-" + key])
        defer { withExtendedLifetime(launchResource) {} }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == url }
        guard options.newInstance || running.count <= 1 else {
            throw ComputerFailure("app_ambiguous", "Multiple processes use this application bundle. Use new_instance=true to launch a distinct target.")
        }
        guard options.newInstance || running.isEmpty || options.arguments.isEmpty else {
            throw ComputerFailure("arguments_require_new_instance", "Launch arguments only apply to a new process. Use new_instance=true or omit arguments when reusing a running app.")
        }
        let affected = options.newInstance ? [] : running.map(\.processIdentifier)
        let resources = try await NativeResources.acquire(affected.filter { isolation?.owns($0) != true }.map { "app-\($0)" } + (options.foreground ? ["foreground"] : []))
        defer { withExtendedLifetime(resources) {} }
        if !options.newInstance, options.foreground, affected.contains(where: { isolation?.owns($0) == true }) {
            throw ComputerFailure("app_concealed", "Reveal the isolated app before foreground launch.")
        }
        snapshot = nil
        for pid in affected {
            if isolation?.owns(pid) == true { try isolation?.advanceRevision(pid) }
            else { try resources.advanceRevision(pid) }
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = options.foreground
        config.allowsRunningApplicationSubstitution = false
        config.createsNewApplicationInstance = options.newInstance
        config.arguments = options.arguments
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        // LaunchServices may finish after cancellation. Drain the tool promptly
        // without replaying launch; a fresh list can discover the late result.
        let app: NSRunningApplication = try await nativeRequest { done in
            let completed: (NSRunningApplication?, Error?) -> Void = { app, error in
                if let error { done(.failure(error)) }
                else if let app { done(.success(app)) }
                else { done(.failure(ComputerFailure("launch_failed", "LaunchServices returned no application."))) }
            }
            if options.urls.isEmpty { NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: completed) }
            else { NSWorkspace.shared.open(options.urls, withApplicationAt: url, configuration: config, completionHandler: completed) }
        }
        try Task.checkCancellation()
        guard app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == url,
              !options.newInstance || !running.contains(where: { $0.processIdentifier == app.processIdentifier }) else {
            throw ComputerFailure("launch_identity_unconfirmed", "LaunchServices returned a different application or reused an existing process. Inspect list before any retry.")
        }
        return try result(["pid": app.processIdentifier, "app_path": url.path, "bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? "",
            "launch_time": processLaunchDate(app.processIdentifier).map { $0.timeIntervalSince1970 as Any } ?? NSNull(), "delivery": options.foreground ? "foreground" : "background",
            "new_instance": options.newInstance, "opened_url_count": options.urls.count, "delivery_status": "unverified"])
    }
}
