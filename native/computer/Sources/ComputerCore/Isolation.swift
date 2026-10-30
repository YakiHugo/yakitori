import AppKit
import ApplicationServices
import Darwin
import DisplayBridge

@MainActor final class IsolationSession {
    private let lockFD: Int32
    private let lockFile: URL
    private let journal: URL
    private var owners: [Int32: NativeResources] = [:]
    private(set) var records: [ParkedWindow] = []

    init() throws {
        try IsolationFiles.prepare()
        let name = "lease_" + UUID().uuidString
        let pending = IsolationFiles.directory.appendingPathComponent(name + ".pending")
        lockFile = IsolationFiles.directory.appendingPathComponent(name + ".lock")
        journal = IsolationFiles.directory.appendingPathComponent(name + ".json")
        let fd = open(pending.path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ComputerFailure("isolation_failed", "Could not create the isolation lease.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0, rename(pending.path, lockFile.path) == 0 else {
            close(fd); unlink(pending.path)
            throw ComputerFailure("isolation_failed", "Could not publish the locked isolation lease.")
        }
        lockFD = fd
    }

    deinit {
        flock(lockFD, LOCK_UN); close(lockFD)
        // Retain a journal/lock pair for the service if recovery is still needed.
        if records.isEmpty { unlink(lockFile.path) }
    }

    func owns(_ pid: Int32) -> Bool { owners[pid] != nil }
    func advanceRevision(_ pid: Int32) throws { try owners[pid]?.advanceRevision(pid) }

    func display() async throws -> IsolationReady {
        guard YKDisplaySupported(), YKWindowSpacesSupported() else { throw ComputerFailure("isolation_unsupported", "The optional macOS virtual display and desktop-restoration interfaces are unavailable.") }
        var launched = false
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while true {
            try Task.checkCancellation()
            if let ready = try isolationDisplayReady() { return ready }
            if !launched {
                guard let executable = Bundle.main.executablePath else { throw ComputerFailure("isolation_failed", "Could not resolve the signed helper executable.") }
                let pid = YKStartDisplayService(executable, IsolationFiles.directory.path)
                guard pid > 0 else { throw ComputerFailure("isolation_failed", "Could not launch the isolated display service (\(pid)).") }
                DispatchQueue.global(qos: .utility).async { var status: Int32 = 0; waitpid(pid, &status, 0) }
                launched = true
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerFailure("isolation_failed", "The isolated display did not become ready; no windows were moved.") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func conceal(pid: Int32, launch: Double, computer: Computer) async throws -> IsolationReady {
        guard !owns(pid) else { throw ComputerFailure("already_concealed", "This helper already owns the app's isolation lease.") }
        let owner = try await NativeResources.acquire(["app-\(pid)"])
        let ready = try await display()
        guard let app = NSRunningApplication(processIdentifier: pid), app.launchDate?.timeIntervalSince1970 == launch else {
            throw ComputerFailure("stale_snapshot", "The target process incarnation changed.")
        }
        let bounds = CGDisplayBounds(ready.displayID)
        guard YKDisplaySpace(ready.displayID) != 0 else { throw ComputerFailure("isolation_failed", "The isolated display has no readable desktop identity.") }
        // Display creation rearranges WindowServer and AppKit asynchronously.
        // Resolve the complete read-only preflight before journaling/moving any
        // window; never retry a concealment mutation to handle that transition.
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        var resolved: [(WindowIdentity, AXUIElement)] = []
        while true {
            try Task.checkCancellation()
            let windows = try computer.windows().filter { $0.pid == pid && $0.layer == 0 }
            guard !windows.isEmpty else { throw ComputerFailure("window_not_found", "There are no visible document windows to conceal.") }
            resolved = windows.compactMap { window in windowElement(window).map { (window, $0) } }
            if resolved.count == windows.count { break }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerFailure("isolation_failed", "The app's visible window identities did not settle after display creation; no windows were moved.") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let targets = try resolved.enumerated().map { index, target -> (WindowIdentity, AXUIElement, CGRect, UInt64) in
            let (window, element) = target
            let originalSpace = YKWindowSpace(window.windowID)
            guard originalSpace != 0 else { throw ComputerFailure("isolation_unsupported", "Concealment requires an exact single desktop membership per window.") }
            guard window.frame.width <= bounds.width - 64, window.frame.height <= bounds.height - 64 else { throw ComputerFailure("isolation_failed", "Every target window must fit the isolated display.") }
            let offset = Double(index % 8) * 24
            let frame = CGRect(x: bounds.minX + 32 + min(offset, bounds.width - window.frame.width - 64),
                y: bounds.minY + 32 + min(offset, bounds.height - window.frame.height - 64), width: window.frame.width, height: window.frame.height)
            return (window, element, frame, originalSpace)
        }
        guard !app.isTerminated, app.launchDate?.timeIntervalSince1970 == launch else {
            throw ComputerFailure("stale_snapshot", "The target process exited during concealment preflight; no windows were moved.")
        }
        owners[pid] = owner
        try owner.advanceRevision(pid)
        for (identity, element, parked, originalSpace) in targets {
            try Task.checkCancellation()
            let record = ParkedWindow(pid: pid, launchTime: launch, windowID: identity.windowID, original: identity.frame, parked: parked,
                originalSpace: originalSpace, parkedDisplay: ready.displayID, displayServicePID: ready.servicePID)
            let next = records + [record]
            // Persist recovery intent before the first external window move.
            try IsolationFiles.persist(next, to: journal)
            records = next
            var position = parked.origin
            guard let encoded = AXValueCreate(.cgPoint, &position),
                  AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, encoded) == .success,
                  let actual = elementFrame(element) else {
                throw ComputerFailure("isolation_failed", "The window did not move onto the isolated display; restoration is required.")
            }
            // WindowServer may adjust titlebar margins. Save its confirmed
            // position before accepting placement or attempting restoration.
            records[records.count - 1] = ParkedWindow(pid: pid, launchTime: launch, windowID: identity.windowID, original: identity.frame, parked: actual,
                originalSpace: originalSpace, parkedDisplay: ready.displayID, displayServicePID: ready.servicePID)
            try IsolationFiles.persist(records, to: journal)
            guard bounds.contains(actual) else { throw ComputerFailure("isolation_failed", "WindowServer did not keep the whole window on the isolated display.") }
        }
        return ready
    }

    func reveal(pid: Int32? = nil) async throws {
        for owned in owners.keys where pid == nil || pid == owned { try owners[owned]?.advanceRevision(owned) }
        var issues: [String] = []
        var remaining: [ParkedWindow] = []
        var completed: [ParkedWindow] = []
        // A display transition temporarily hides identities from AX. Bound
        // read-only readiness waits across this restoration, never retry writes.
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        for record in records {
            if let pid, record.pid != pid { remaining.append(record); continue }
            let outcome = try await awaitWindowRestoration(record, deadline: deadline)
            switch outcome {
            case .complete: completed.append(record)
            case .waiting(let reason, _), .pending(let reason):
                issues.append("Window \(record.windowID): \(reason)"); remaining.append(record)
            }
        }
        try await retireRestoredWindows(completed)
        try IsolationFiles.persist(remaining, to: journal)
        records = remaining
        for owned in Array(owners.keys) where !records.contains(where: { $0.pid == owned }) { owners.removeValue(forKey: owned) }
        if records.contains(where: { pid == nil || $0.pid == pid }) {
            throw ComputerFailure("restoration_failed", "\(issues.joined(separator: "; ")). Restoration records remain pending; retry reveal after the native window state is available.")
        }
    }
}

extension Computer {
    func isolate(_ args: [String: Any]) async throws -> [String: Any] {
        guard let action = args["isolation_action"] as? String, ["status", "conceal", "reveal"].contains(action) else {
            throw ComputerFailure("invalid_arguments", "isolation_action must be status, conceal, or reveal.")
        }
        if action == "status" {
            let ready = try isolationDisplayReady()
            return try result(["supported": YKDisplaySupported() && YKWindowSpacesSupported(), "display_id": ready.map { $0.displayID as Any } ?? NSNull(),
                "service_pid": ready.map { $0.servicePID as Any } ?? NSNull(), "owned_windows": isolation?.records.count ?? 0])
        }
        guard AXIsProcessTrusted(), action == "reveal" || CGPreflightScreenCaptureAccess() else { throw ComputerFailure("permission_required", "Concealment requires Accessibility and Screen Recording; restoration only requires Accessibility.") }
        snapshot = nil
        if action == "reveal" {
            let pid = args["pid"] as? Int32
            guard args["pid"] == nil || (pid != nil && pid! > 0) else { throw ComputerFailure("invalid_arguments", "pid must be a positive process ID.") }
            try await isolation?.reveal(pid: pid)
            if isolation?.records.isEmpty == true { isolation = nil }
            let recovered = try await recoverIsolationLeases(pid: pid)
            return try result(["effect": recovered.pending == 0 ? "restored" : "restoration_pending",
                "remaining_windows": (isolation?.records.count ?? 0) + recovered.pending])
        }
        guard let pid = args["pid"] as? Int32, let launch = args["launch_time"] as? Double,
              NSRunningApplication(processIdentifier: pid)?.launchDate?.timeIntervalSince1970 == launch else {
            throw ComputerFailure("invalid_arguments", "Concealment requires pid and launch_time from list.")
        }
        let session = try isolation ?? IsolationSession()
        isolation = session
        do {
            let ready = try await session.conceal(pid: pid, launch: launch, computer: self)
            return try result(["effect": "concealed", "display_id": ready.displayID, "service_pid": ready.servicePID, "owned_windows": session.records.count])
        } catch {
            do { try await session.reveal(pid: pid) }
            catch let cleanup {
                throw ComputerFailure("restoration_failed", "Concealment stopped and restoration remains pending: \(cleanup). Run isolation reveal; the recovery service retains the journal.")
            }
            if session.records.isEmpty { isolation = nil }
            throw error
        }
    }
}
