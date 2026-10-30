import AppKit

extension Computer {
    func sequence(_ args: [String: Any]) async throws -> [String: Any] {
        guard let steps = args["steps"] as? [[String: Any]], !steps.isEmpty, steps.count <= 64,
              let pid = args["pid"] as? Int32, let launch = args["launch_time"] as? Double else {
            throw ComputerFailure("invalid_arguments", "sequence requires pid/launch_time and 1...64 explicit steps within the native batch safety boundary.")
        }
        let request = try ObservationRequest(args)
        guard request.scope != .screen else { throw ComputerFailure("invalid_arguments", "A sequence targets one application, never the shared screen.") }
        if args["after"] != nil, ObservationMode(rawValue: args["after"] as? String ?? "") == nil { throw ComputerFailure("invalid_arguments", "after must be ax, vision, or both.") }
        if args["expect"] != nil { _ = try AXExpectation(args["expect"]); _ = try waitTimeout(args) }
        let allowed = Set(["press", "perform_action", "set_value", "select_text", "type", "paste", "key", "keys", "wait_for"])
        for step in steps {
            guard let action = step["action"] as? String, allowed.contains(action),
                  step["pid"] == nil, step["window_id"] == nil, step["scope"] == nil, step["snapshot_id"] == nil,
                  step["element"] == nil, step["x"] == nil, step["y"] == nil else {
                throw ComputerFailure("invalid_arguments", "Sequence steps cannot switch targets or reuse element/pixel indices; use exact selectors.")
            }
            if action == "wait_for" { _ = try AXExpectation(step["expect"]); _ = try waitTimeout(step) }
            else {
                guard try AXExpectation(step["selector"]).exists else { throw ComputerFailure("invalid_arguments", "An input selector must identify an existing element.") }
                try validateInput(action, step)
            }
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        let work = Task { @MainActor in try await executeSequence(steps, args: args, pid: pid, launch: launch, deadline: deadline) }
        let timer = Task {
            do { try await Task.sleep(nanoseconds: 30_000_000_000) }
            catch is CancellationError { return }
            work.cancel()
        }
        defer { timer.cancel() }
        // Await cancellation cleanup before returning; no held input may escape
        // the batch deadline or its caller's cancellation barrier.
        return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
    }

    private func executeSequence(_ steps: [[String: Any]], args: [String: Any], pid: Int32, launch: Double, deadline: TimeInterval) async throws -> [String: Any] {
        var completed: [[String: Any]] = []
        var executing = 0
        do {
            for (index, step) in steps.enumerated() {
                executing = index
                try Task.checkCancellation()
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerFailure("native_timeout", "The batch exceeded its 30-second execution safety boundary.") }
                guard NSRunningApplication(processIdentifier: pid)?.launchDate?.timeIntervalSince1970 == launch else { throw ComputerFailure("stale_snapshot", "The sequence target process incarnation changed.") }
                var target = args
                target["mode"] = "ax"; target["disable_diff"] = true
                target.removeValue(forKey: "steps"); target.removeValue(forKey: "root_element")
                let outcome: [String: Any]
                if step["action"] as? String == "wait_for" {
                    target.merge(step) { _, value in value }
                    outcome = try await wait(target, change: false)
                } else {
                    // Fixed caller-supplied native steps only: no planning,
                    // branches, automatic retries, or cross-application control.
                    _ = try await observe(target)
                    var input = step
                    input["snapshot_id"] = snapshot?.id
                    outcome = try await self.input(step["action"] as! String, input)
                }
                let evidence = outcome["structuredContent"] as! [String: Any]
                // Keep the batch reply within MCP framing even when each step
                // requests an image/tree. Full evidence remains queryable as the
                // last observation; return at most one final observation.
                var summary = evidence.filter { ["effect", "delivery", "verification", "selection", "value_matches", "matched", "timed_out", "after_error"].contains($0.key) }
                summary["action"] = step["action"]
                completed.append(summary)
                if evidence["after_error"] != nil || evidence["verification"] as? String == "timed_out" || evidence["matched"] as? Bool == false {
                    throw ComputerFailure("sequence_stopped", "A postcondition was not established; later steps were not executed.")
                }
            }
            guard let lastObservation else { preconditionFailure("A nonempty native batch must have observed its target") }
            return try await completeInput(["completed_steps": completed, "effect": "unverified"], args: args, ticket: lastObservation)
        } catch {
            snapshot = nil
            let failure = error as? ComputerFailure
            let cancelled = ProcessInfo.processInfo.systemUptime >= deadline ? "native_timeout" : "cancelled"
            throw ComputerFailure(error is CancellationError ? cancelled : failure?.code ?? "sequence_failed",
                "Sequence stopped; earlier steps may have effects. \(failure?.message ?? error.localizedDescription)",
                evidence: ["completed_steps": completed, "stopped_at": executing, "effect": "unverified"])
        }
    }
}
