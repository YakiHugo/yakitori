import AppKit
import ApplicationServices
import CryptoKit

private final class AXChanges {
    var changed = false
    private var observers: [AXObserver] = []

    init(windows: [WindowIdentity]) {
        let callback: AXObserverCallback = { _, _, _, context in
            if let context { Unmanaged<AXChanges>.fromOpaque(context).takeUnretainedValue().changed = true }
        }
        for pid in Set(windows.map(\.pid)) {
            var observer: AXObserver?
            guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { continue }
            let app = AXUIElementCreateApplication(pid)
            let elements = [app] + (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []) +
                (attribute(app, kAXFocusedUIElementAttribute).map { [$0 as! AXUIElement] } ?? [])
            for element in elements {
                for name in [kAXValueChangedNotification, kAXSelectedTextChangedNotification, kAXFocusedUIElementChangedNotification,
                    kAXWindowCreatedNotification, kAXUIElementDestroyedNotification, kAXLayoutChangedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification] {
                    AXObserverAddNotification(observer, element, name as CFString, Unmanaged.passUnretained(self).toOpaque())
                }
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            observers.append(observer)
        }
    }

    deinit {
        for observer in observers { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
    }
}

func waitTimeout(_ args: [String: Any]) throws -> TimeInterval {
    let timeout = (args["timeout"] as? NSNumber)?.doubleValue ?? 5
    // Bound one polling operation, independently of task/model execution time.
    guard args["timeout"] == nil || args["timeout"] is NSNumber,
          timeout.isFinite, (0.1...30).contains(timeout) else {
        throw ComputerFailure("invalid_arguments", "timeout must be within the 0.1...30 second native-wait safety boundary.")
    }
    return timeout
}

extension Computer {
    func wait(_ args: [String: Any], change: Bool) async throws -> [String: Any] {
        let timeout = try waitTimeout(args)
        let expectation = change ? nil : try AXExpectation(args["expect"])
        var target = args
        if args["pid"] == nil && args["scope"] == nil && args["display_id"] == nil, let lastObservation {
            target = lastObservation.observationArguments(mode: args["mode"] as? String ?? "ax")
        }
        target["mode"] = target["mode"] ?? "ax"
        target["disable_diff"] = true
        if !change && target["mode"] as? String == "vision" { throw ComputerFailure("invalid_arguments", "AX expectations require mode=ax or both.") }
        _ = try ObservationRequest(target)
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var baseline: Data?
        var monitor: AXChanges?
        var latest: [String: Any]?
        while true {
            try Task.checkCancellation()
            do { latest = try await observe(target) }
            catch let error as ComputerFailure where error.code == "stale_snapshot" {
                if ProcessInfo.processInfo.systemUptime >= deadline { throw error }
                try await Task.sleep(nanoseconds: 30_000_000)
                continue
            }
            guard let current = lastObservation, var data = latest?["structuredContent"] as? [String: Any] else { preconditionFailure("Observation must store its snapshot") }
            let matched: Bool
            if change {
                // Notifications catch short-lived AX transitions; sampled AX and
                // pixels cover providers/canvases that emit no AX notifications.
                var fingerprint = try JSONSerialization.data(withJSONObject: current.rows, options: [.sortedKeys])
                if let image = (latest?["content"] as? [[String: Any]])?.first(where: { $0["type"] as? String == "image" })?["data"] as? String {
                    fingerprint.append(contentsOf: SHA256.hash(data: Data(image.utf8)))
                }
                matched = monitor?.changed == true || baseline.map { $0 != fingerprint } == true
                if baseline == nil { baseline = fingerprint; monitor = AXChanges(windows: current.windows) }
            } else { matched = expectation!.satisfied(by: current) }
            let expired = ProcessInfo.processInfo.systemUptime >= deadline
            if matched || expired {
                data[change ? "changed" : "matched"] = matched
                data["timed_out"] = !matched
                var result = latest!
                result["structuredContent"] = data
                let text = try self.result(data)["content"] as! [[String: Any]]
                result["content"] = text + ((latest?["content"] as? [[String: Any]]) ?? []).filter { $0["type"] as? String == "image" }
                return result
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func completeInput(_ evidence: [String: Any], args: [String: Any], ticket: Snapshot) async throws -> [String: Any] {
        var data = evidence
        var images: [[String: Any]] = []
        do {
            if args["expect"] != nil {
                var target = ticket.observationArguments()
                target["expect"] = args["expect"]; target["timeout"] = args["timeout"]
                let checked = try await wait(target, change: false)
                let state = checked["structuredContent"] as! [String: Any]
                data["verification"] = state["matched"] as? Bool == true ? "matched" : "timed_out"
                data["observation"] = state
            }
            if let after = args["after"] as? String {
                let observed = try await observe(ticket.observationArguments(mode: after))
                data["observation"] = observed["structuredContent"]
                images = (observed["content"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "image" }
            }
        } catch let error as ComputerFailure {
            // The input already happened. Preserve its delivery evidence instead
            // of reporting the observation failure as if nothing had been sent.
            data["after_error"] = ["code": error.code, "message": error.message]
        }
        var result = try self.result(data)
        result["content"] = (result["content"] as! [[String: Any]]) + images
        return result
    }
}
