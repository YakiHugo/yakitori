import AppKit
import Darwin

// WindowServer may reassign windows again when their former virtual display is
// removed, after an earlier AX restoration was fully confirmed. Retain that
// recovery intent until the display's lifetime has ended as well.
@MainActor func retireRestoredWindows(_ records: [ParkedWindow]) async throws {
    for record in records {
        let name = "retired_\(record.pid)_\(record.launchTime.bitPattern)_\(record.windowID).json"
        let file = IsolationFiles.directory.appendingPathComponent(name)
        // The caller holds this app's mutation lock. Latest completed intent
        // replaces older turns, bounding history by windows instead of turns.
        _ = try await withRetiredLock(file, wait: true) { try IsolationFiles.persist([record], to: file) }
    }
}

@MainActor private func withRetiredLock(_ file: URL, wait: Bool, body: () async throws -> Void) async throws -> Bool {
    let lock = file.deletingPathExtension().appendingPathExtension("lock")
    let fd = open(lock.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw ComputerFailure("recovery_failed", "Could not open the retired restoration lock.") }
    defer { close(fd) }
    guard flock(fd, wait ? LOCK_EX : LOCK_EX | LOCK_NB) == 0 else {
        guard !wait && (errno == EWOULDBLOCK || errno == EAGAIN) else { throw ComputerFailure("recovery_failed", "Could not lock retired restoration intent.") }
        return false
    }
    // Keep the lock inode stable after deleting journal data. Another process
    // may already have this path open while waiting; unlinking it would let a
    // later opener lock a different inode for the same restoration record.
    defer { flock(fd, LOCK_UN) }
    try await body()
    return true
}

@MainActor func recoverRetiredWindows(pid: Int32? = nil) async throws -> Int {
    let files = try FileManager.default.contentsOfDirectory(at: IsolationFiles.directory, includingPropertiesForKeys: nil)
    var pending = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    for file in files where file.lastPathComponent.hasPrefix("retired_") && file.pathExtension == "json" {
        _ = try await withRetiredLock(file, wait: false) {
            let records: [ParkedWindow]
            do { records = try JSONDecoder().decode([ParkedWindow].self, from: Data(contentsOf: file)) }
            catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return }
            var remaining: [ParkedWindow] = []
            for record in records {
                if let pid, record.pid != pid { remaining.append(record); continue }
                // Online retired records do not prevent an idle display shutdown.
                guard try !displayIsOnline(record.parkedDisplay) || kill(record.displayServicePID, 0) != 0 else { remaining.append(record); continue }
                guard let resource = try NativeResources.tryAcquire("app-\(record.pid)") else { pending += 1; remaining.append(record); continue }
                defer { withExtendedLifetime(resource) {} }
                try resource.advanceRevision(record.pid)
                if case .complete = try await awaitWindowRestoration(record, deadline: deadline) { continue }
                pending += 1
                remaining.append(record)
            }
            try IsolationFiles.persist(remaining, to: file)
        }
    }
    return pending
}
