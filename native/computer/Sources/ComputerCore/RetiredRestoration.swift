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
        let lock = try await NativeFileLock.acquire(file.deletingPathExtension().appendingPathExtension("lock"), deadline: ProcessInfo.processInfo.systemUptime + 5)
        defer { withExtendedLifetime(lock) {} }
        try IsolationFiles.persist([record], to: file)
    }
}

@MainActor func recoverRetiredWindows(pid: Int32? = nil) async throws -> Int {
    let files = Set(try FileManager.default.contentsOfDirectory(at: IsolationFiles.directory, includingPropertiesForKeys: nil))
    let retired = Set(files.filter { $0.lastPathComponent.hasPrefix("retired_") && ["json", "lock"].contains($0.pathExtension) }.map { $0.deletingPathExtension() })
    var pending = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    for stem in retired.sorted(by: { $0.path < $1.path }) {
        let file = stem.appendingPathExtension("json"), lockPath = stem.appendingPathExtension("lock")
        guard let recordPID = stem.lastPathComponent.split(separator: "_").dropFirst().first.flatMap({ Int32($0) }),
              pid == nil || pid == recordPID else { continue }
        if try NativeFileLock.pruneExitedProcess(recordPID, lock: lockPath, data: file) { continue }
        guard files.contains(file), let lock = try NativeFileLock.tryAcquire(lockPath) else { continue }
        defer { withExtendedLifetime(lock) {} }
        let records: [ParkedWindow]
        do { records = try JSONDecoder().decode([ParkedWindow].self, from: Data(contentsOf: file)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { continue }
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
    return pending
}
