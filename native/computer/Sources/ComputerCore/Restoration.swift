import AppKit
import ApplicationServices
import Darwin
import DisplayBridge

struct ParkedWindow: Codable {
    let pid: Int32
    let launchTime: Double
    let windowID: UInt32
    let original: CGRect
    let parked: CGRect
    let originalSpace: UInt64
    let parkedDisplay: UInt32
    let displayServicePID: Int32
}

enum IsolationFiles {
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Yakitori/Computer/isolation")
    }
    static var ready: URL { directory.appendingPathComponent("ready.json") }
    static var serviceLock: URL { directory.appendingPathComponent("service.lock") }

    static func prepare() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    static func persist(_ records: [ParkedWindow], to file: URL) throws {
        if records.isEmpty {
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        } else {
            try JSONEncoder().encode(records).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            let handle = try FileHandle(forWritingTo: file)
            try handle.synchronize(); try handle.close()
        }
    }
}

enum WindowRestoration {
    case complete
    case waiting(String, spaceMoveRequested: Bool = false)
    case pending(String)
}

@MainActor func restoreParkedWindow(_ record: ParkedWindow, allowSpaceMove: Bool = true) throws -> WindowRestoration {
    guard let app = NSRunningApplication(processIdentifier: record.pid), !app.isTerminated,
          app.launchDate?.timeIntervalSince1970 == record.launchTime else { return .complete }
    guard let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return .waiting("WindowServer list unavailable") }
    let row = rows.first(where: { $0[kCGWindowNumber as String] as? UInt32 == record.windowID && $0[kCGWindowOwnerPID as String] as? Int32 == record.pid })
    let current = (row?[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
    func restoreSpace() -> WindowRestoration {
        guard allowSpaceMove else { return .waiting("Waiting for original desktop membership") }
        guard YKRestoreWindowSpace(record.windowID, record.originalSpace) else { return .pending("Original desktop restoration is unavailable on this macOS release") }
        return .waiting("Waiting for original desktop membership", spaceMoveRequested: true)
    }
    let space = YKWindowSpace(record.windowID)
    // Disconnection may reassign different windows to different physical
    // desktops. Restore the recorded membership only while geometry still
    // matches our parked/original location, preserving a later user move.
    let displayLost = try kill(record.displayServicePID, 0) != 0 || !displayIsOnline(record.parkedDisplay)
    if space != 0, space != record.originalSpace, let current,
       current.origin == record.original.origin || (displayLost && current.origin == record.parked.origin) {
        return restoreSpace()
    }
    let appElement = AXUIElementCreateApplication(record.pid)
    AXUIElementSetMessagingTimeout(appElement, 0.2)
    guard let windows = attribute(appElement, kAXWindowsAttribute) as? [AXUIElement] else { return .waiting("AX window list unavailable") }
    let candidates = windows.filter {
        if let id = accessibilityWindowID($0) { return id == record.windowID }
        guard let frame = elementFrame($0) else { return false }
        return frame == current || frame == record.parked
    }
    if candidates.isEmpty && row == nil { return .complete }
    guard candidates.count == 1, let window = candidates.first, let frame = elementFrame(window) else { return .waiting("Exact AX identity unresolved (\(candidates.count) candidates)") }
    func finish() -> WindowRestoration {
        let membership = YKWindowSpace(record.windowID)
        guard membership != 0 else { return .waiting("Original desktop membership is unreadable") }
        if membership != record.originalSpace { return restoreSpace() }
        // AX can acknowledge the original frame before WindowServer applies it.
        // Keep the journal until both independent views agree; a subsequent
        // concealment must not adopt the still-parked geometry as its baseline.
        guard let current, abs(current.minX - record.original.minX) < 2,
              abs(current.minY - record.original.minY) < 2 else {
            return .waiting("Waiting for WindowServer position confirmation")
        }
        // Display disconnection can restore geometry while leaving a formerly
        // visible window unordered. Re-expose that exact window without an
        // application activation or a synthetic foreground-input retry.
        if row?[kCGWindowIsOnscreen as String] as? Bool != true, !app.isHidden,
           attribute(window, kAXMinimizedAttribute) as? Bool != true,
           AXUIElementPerformAction(window, kAXRaiseAction as CFString) != .success {
            return .pending("Restored window could not be made visible")
        }
        return .complete
    }
    if frame.origin == record.original.origin { return finish() }
    // Real user movement, or WindowServer rescue after service death, ends our
    // ownership. Do not overwrite a position chosen after concealment.
    let axStillParked = abs(frame.minX - record.parked.minX) < 2 && abs(frame.minY - record.parked.minY) < 2
    let serverStillParked = current.map { abs($0.minX - record.parked.minX) < 2 && abs($0.minY - record.parked.minY) < 2 } ?? false
    // AX's coordinate conversion can lag a desktop transfer while WindowServer
    // still reports our exact parked origin. That disagreement is a transition,
    // not evidence that the user chose a new position.
    guard axStillParked || serverStillParked else { return .complete }
    var point = record.original.origin
    guard let encoded = AXValueCreate(.cgPoint, &point),
          AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, encoded) == .success,
          let actual = elementFrame(window) else { return .pending("AX position restoration refused") }
    return abs(actual.minX - point.x) < 2 && abs(actual.minY - point.y) < 2 ? finish() : .pending("AX position readback differs from requested restoration")
}

@MainActor func awaitWindowRestoration(_ record: ParkedWindow, deadline: TimeInterval) async throws -> WindowRestoration {
    var allowSpaceMove = true
    var confirmedSince: TimeInterval?
    var outcome = try restoreParkedWindow(record)
    while true {
        let now = ProcessInfo.processInfo.systemUptime
        switch outcome {
        case .complete:
            // A desktop transfer can briefly expose its destination before the
            // window geometry settles. Hold ownership across separate AppKit /
            // WindowServer samples before letting a new concealment start.
            confirmedSince = confirmedSince ?? now
            if now - confirmedSince! >= 0.1 { return .complete }
        case .pending: return outcome
        case .waiting(_, let requested):
            confirmedSince = nil
            allowSpaceMove = allowSpaceMove && !requested
        }
        guard now < deadline else {
            if case .complete = outcome { return .waiting("Waiting for stable restoration confirmation") }
            return outcome
        }
        // Cleanup also runs from cancelled requests. Keep ownership while
        // observing the submitted move; never enqueue it again during polling.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { continuation.resume() }
        }
        outcome = try restoreParkedWindow(record, allowSpaceMove: allowSpaceMove)
    }
}

@MainActor func recoverIsolationLeases(pid: Int32? = nil) async throws -> (live: Int, pending: Int) {
    let files = try FileManager.default.contentsOfDirectory(at: IsolationFiles.directory, includingPropertiesForKeys: nil)
    var live = 0, pending = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    for lock in files where lock.lastPathComponent.hasPrefix("lease_") && lock.pathExtension == "lock" {
        let fd = open(lock.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { continue }
        guard fd >= 0 else { throw ComputerFailure("recovery_failed", "Could not inspect an isolation lease.") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw ComputerFailure("recovery_failed", "Could not inspect the isolation lease lock.") }
            live += 1; continue
        }
        defer { flock(fd, LOCK_UN) }
        let journal = lock.deletingPathExtension().appendingPathExtension("json")
        if FileManager.default.fileExists(atPath: journal.path) {
            let records = try JSONDecoder().decode([ParkedWindow].self, from: Data(contentsOf: journal))
            var remaining: [ParkedWindow] = []
            for record in records {
                if let pid, record.pid != pid { remaining.append(record); continue }
                guard let resource = try NativeResources.tryAcquire("app-\(record.pid)") else { remaining.append(record); continue }
                defer { withExtendedLifetime(resource) {} }
                try resource.advanceRevision(record.pid)
                if case .complete = try await awaitWindowRestoration(record, deadline: deadline) {
                    try await retireRestoredWindows([record])
                } else { remaining.append(record) }
            }
            try IsolationFiles.persist(remaining, to: journal)
            pending += remaining.count
            if !remaining.isEmpty { continue }
        }
        try FileManager.default.removeItem(at: lock)
    }
    pending += try await recoverRetiredWindows(pid: pid)
    return (live, pending)
}
