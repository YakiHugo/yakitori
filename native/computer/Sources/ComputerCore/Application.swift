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

struct ApplicationInstance {
    let application: NSRunningApplication
    let url: URL?
    let launched: Date?
    let name: String
    let bundleID: String?

    init(_ application: NSRunningApplication) {
        self.application = application
        let started = processLaunchDate(application.processIdentifier)
        url = application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL
        name = application.localizedName ?? ""
        bundleID = application.bundleIdentifier
        launched = !application.isTerminated && started == processLaunchDate(application.processIdentifier) ? started : nil
    }

    var isCurrent: Bool {
        launched != nil && !application.isTerminated && processLaunchDate(application.processIdentifier) == launched
    }

    var data: [String: Any] {
        ["pid": application.processIdentifier, "name": name, "bundle_id": bundleID ?? "", "app_path": url?.path ?? "",
            "launch_time": launched.map { $0.timeIntervalSince1970 as Any } ?? NSNull(),
            "hidden": application.isHidden, "active": application.isActive]
    }
}

func installedApplicationData(_ url: URL) -> [String: Any] {
    let bundle = Bundle(url: url)
    return ["app_path": url.path, "bundle_id": bundle?.bundleIdentifier ?? "",
        "name": bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? url.deletingPathExtension().lastPathComponent]
}

func applicationURL(_ target: ApplicationTarget, roots: [URL], running: [URL]) throws -> URL {
    let url: URL
    switch target {
    case .bundleID(let id):
        let active = Set(running.filter { Bundle(url: $0)?.bundleIdentifier?.caseInsensitiveCompare(id) == .orderedSame }
            .map { $0.resolvingSymlinksInPath().standardizedFileURL })
        guard active.count <= 1 else {
            throw ComputerFailure("app_ambiguous", "Multiple running installations have bundle_id \(id); choose a candidate app_path.",
                evidence: ["ambiguity": "installation", "candidates": active.sorted { $0.path < $1.path }.map(installedApplicationData)])
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
                    : "Multiple applications match \(name); choose a candidate app_path.",
                evidence: matches.isEmpty ? [:] : ["ambiguity": "installation", "candidates": matches.map(installedApplicationData)])
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
    func applicationCandidates(_ instances: [ApplicationInstance]) -> [[String: Any]] {
        let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]]
        return instances.sorted { $0.application.processIdentifier < $1.application.processIdentifier }.map { instance in
            var data = instance.data
            // Unknown window discovery is not evidence that an app has no windows.
            data["windows"] = rows.map { rows in
                rows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == instance.application.processIdentifier }.compactMap { row -> [String: Any]? in
                    guard let id = row[kCGWindowNumber as String] as? UInt32,
                          let bounds = row[kCGWindowBounds as String] as? [String: Any],
                          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                          frame.width > 1, frame.height > 1 else { return nil }
                    return ["window_id": id, "title": row[kCGWindowName as String] as? String ?? "", "frame": frameData(frame)]
                }
            } as Any? ?? NSNull()
            return data
        }
    }

    func launch(_ args: [String: Any]) async throws -> [String: Any] {
        var stage = "selection"
        var dispatched = false
        var requested = args.filter { ["bundle_id", "app_path", "app_name", "pid", "launch_time", "new_instance", "delivery", "open_urls"].contains($0.key) }
        var returned: [String: Any]?
        do {
            let options = try ApplicationLaunchOptions(args)
            let pinned: ApplicationInstance?
            let url: URL
            if args["pid"] != nil || args["launch_time"] != nil {
                guard !["bundle_id", "app_path", "app_name"].contains(where: { args[$0] != nil }),
                      let number = args["pid"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      let pid = args["pid"] as? Int32, pid > 0,
                      let birth = args["launch_time"] as? NSNumber, CFGetTypeID(birth) != CFBooleanGetTypeID(),
                      birth.doubleValue.isFinite, birth.doubleValue > 0, !options.newInstance else {
                    throw ComputerFailure("invalid_arguments", "Select an existing process with only pid and its launch_time; new_instance requires an installation selector.")
                }
                guard options.urls.isEmpty else {
                    throw ComputerFailure("process_open_unsupported", "URL/document delivery to an exact process is unsupported. An installation selector may only be used when that installation's instance selection is acceptable.")
                }
                guard let app = NSRunningApplication(processIdentifier: pid) else {
                    throw ComputerFailure("stale_target", "The selected process exited; list targets again.")
                }
                let instance = ApplicationInstance(app)
                guard instance.isCurrent, instance.launched?.timeIntervalSince1970 == birth.doubleValue, let path = instance.url else {
                    throw ComputerFailure("stale_target", "The selected process identity changed or is unavailable; list targets again.",
                        evidence: ["candidates": applicationCandidates([instance])])
                }
                pinned = instance
                url = path
            } else {
                pinned = nil
                url = try applicationURL(ApplicationTarget(args), roots: [
                    "/Applications", "/System/Applications", "/System/Library/CoreServices", NSHomeDirectory() + "/Applications",
                ].map { URL(fileURLWithPath: $0) }, running: NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }.compactMap(\.bundleURL))
            }
            requested["app_path"] = url.path
            let key = SHA256.hash(data: Data(url.path.utf8)).map { String(format: "%02x", $0) }.joined()
            let launchResource = try await NativeResources.acquire(["launch-" + key])
            defer { withExtendedLifetime(launchResource) {} }
            let running = NSWorkspace.shared.runningApplications.filter {
                !$0.isTerminated && $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == url
            }.map(ApplicationInstance.init)
            guard pinned != nil || options.newInstance || running.count <= 1 else {
                throw ComputerFailure("app_ambiguous", "Multiple processes use this installation. Choose pid and launch_time from candidates, then observe its window; creating another process is a separate decision.",
                    evidence: ["ambiguity": "process", "candidates": applicationCandidates(running)])
            }
            let existing = pinned ?? (options.newInstance ? nil : running.first)
            guard existing == nil || options.arguments.isEmpty else {
                throw ComputerFailure("arguments_require_new_instance", "Launch arguments cannot be applied to an existing process. Omit arguments to bind it, or explicitly request a new instance.",
                    evidence: ["candidates": applicationCandidates(existing.map { [$0] } ?? [])])
            }
            let affected = existing.map { [$0.application.processIdentifier] } ?? []
            let resources = try await NativeResources.acquire(affected.filter { isolation?.owns($0) != true }.map { "app-\($0)" } + (options.foreground ? ["foreground"] : []))
            defer { withExtendedLifetime(resources) {} }
            if let existing {
                guard existing.isCurrent else {
                    throw ComputerFailure("stale_target", "The selected process exited or its identity is unavailable; list targets again.",
                        evidence: ["candidates": applicationCandidates([existing])])
                }
                if options.foreground, isolation?.owns(existing.application.processIdentifier) == true {
                    throw ComputerFailure("app_concealed", "Reveal the isolated app before foreground activation.")
                }
            }
            try Task.checkCancellation()
            if let existing, options.urls.isEmpty, !options.foreground {
                // Resolving an existing target must not dispatch reopen events,
                // invalidate an input snapshot, or change the app's revision.
                return try result(existing.data.merging(["instance_status": "existing", "mutation_dispatched": false,
                    "effect": "none", "opened_url_count": 0, "delivery": "background"]) { _, value in value })
            }
            snapshot = nil
            for pid in affected {
                if isolation?.owns(pid) == true { try isolation?.advanceRevision(pid) }
                else { try resources.advanceRevision(pid) }
            }
            stage = "dispatch"
            let instance: ApplicationInstance
            if let existing, options.urls.isEmpty {
                dispatched = true
                let error = requestApplicationActivation(existing.application)
                returned = existing.data
                guard error == .success else { throw ComputerFailure("activation_unconfirmed", "macOS did not confirm the activation request (\(error.rawValue)); inspect the target before retrying.") }
                instance = existing
            } else {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = options.foreground
                config.allowsRunningApplicationSubstitution = false
                config.createsNewApplicationInstance = options.newInstance
                config.arguments = options.arguments
                config.addsToRecentItems = false
                config.promptsUserIfNeeded = false
                // A timed-out/cancelled request can still finish. Never replay it.
                let app: NSRunningApplication = try await nativeRequest { done in
                    let completed: (NSRunningApplication?, Error?) -> Void = { app, error in
                        if let error {
                            let native = error as NSError
                            done(.failure(ComputerFailure("launch_failed", error.localizedDescription,
                                evidence: ["native_domain": native.domain, "native_code": native.code])))
                        } else if let app { done(.success(app)) }
                        else { done(.failure(ComputerFailure("launch_failed", "LaunchServices returned no application."))) }
                    }
                    dispatched = true
                    if options.urls.isEmpty { NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: completed) }
                    else { NSWorkspace.shared.open(options.urls, withApplicationAt: url, configuration: config, completionHandler: completed) }
                }
                instance = ApplicationInstance(app)
                returned = instance.data
            }
            stage = "verification"
            try Task.checkCancellation()
            guard instance.url == url, instance.isCurrent,
                  !options.newInstance || !running.contains(where: { $0.application.processIdentifier == instance.application.processIdentifier }),
                  existing == nil || (instance.application.processIdentifier == existing?.application.processIdentifier && instance.launched == existing?.launched) else {
                throw ComputerFailure("launch_identity_unconfirmed", "The returned application, process identity or requested new instance was not confirmed. Inspect list and the returned target before deciding whether another action is needed.")
            }
            // New means absent from the captured inventory, not exclusive ownership.
            return try result(instance.data.merging(["instance_status": existing == nil ? "new" : "existing",
                "mutation_dispatched": dispatched, "effect": "unverified", "delivery": options.foreground ? "foreground" : "background",
                "opened_url_count": options.urls.count, "delivery_status": "unverified"]) { _, value in value })
        } catch let failure as ComputerFailure {
            var evidence = failure.evidence
            evidence["stage"] = stage
            evidence["mutation_dispatched"] = dispatched
            evidence["effect"] = dispatched ? "unverified" : "none"
            evidence["requested"] = requested
            if let returned { evidence["returned"] = returned }
            throw ComputerFailure(failure.code, failure.message, evidence: evidence)
        } catch is CancellationError {
            var evidence: [String: Any] = ["stage": stage, "mutation_dispatched": dispatched,
                "effect": dispatched ? "unverified" : "none", "requested": requested]
            if let returned { evidence["returned"] = returned }
            throw ComputerFailure("cancelled", dispatched
                ? "Application request stopped after dispatch; it may still complete. Inspect list before continuing."
                : "Application request stopped before dispatch; no application action was sent.", evidence: evidence)
        }
    }
}
