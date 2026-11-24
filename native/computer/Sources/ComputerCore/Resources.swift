import Foundation
import Darwin

final class NativeFileLock {
    private let descriptor: Int32

    private init(_ descriptor: Int32) { self.descriptor = descriptor }
    deinit { close(descriptor) }

    static func tryAcquire(_ file: URL) throws -> NativeFileLock? {
        let descriptor = open(file.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ComputerFailure("resource_unavailable", "Could not open the native resource lock.") }
        let lease = NativeFileLock(descriptor)
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw ComputerFailure("resource_unavailable", "Could not lock the native resource.") }
            return nil
        }
        // A cleanup may have unlinked the inode between open and flock.
        var held = stat(), current = stat()
        guard fstat(descriptor, &held) == 0 else { throw ComputerFailure("resource_unavailable", "Could not identify the native resource lock.") }
        guard lstat(file.path, &current) == 0 else {
            guard errno == ENOENT else { throw ComputerFailure("resource_unavailable", "Could not identify the current native resource lock.") }
            return nil
        }
        guard held.st_dev == current.st_dev, held.st_ino == current.st_ino else { return nil }
        return lease
    }

    static func acquire(_ file: URL, deadline: TimeInterval) async throws -> NativeFileLock {
        while true {
            try Task.checkCancellation()
            if let lease = try tryAcquire(file) { return lease }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                throw ComputerFailure("resource_busy", "Another helper is using this native resource; no input was sent.")
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    static func pruneExitedProcess(_ pid: Int32, lock: URL, data: URL) throws -> Bool {
        guard pid > 0, kill(pid, 0) == -1, errno == ESRCH,
              let lease = try tryAcquire(lock) else { return false }
        defer { withExtendedLifetime(lease) {} }
        guard kill(pid, 0) == -1, errno == ESRCH else { return false }
        do { try FileManager.default.removeItem(at: data) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {}
        try FileManager.default.removeItem(at: lock)
        return true
    }
}

// MCP connections own separate helpers. OS input and the clipboard remain
// shared resources, so serialization must cross the process boundary.
final class NativeResources {
    private var locks: [NativeFileLock] = []
    private var names = Set<String>()

    private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Yakitori/Computer/locks")
    }

    private static let preparation = Result {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let names = Set(files.filter { ["lock", "revision"].contains($0.pathExtension) }.map { $0.deletingPathExtension().lastPathComponent })
        for name in names where name.hasPrefix("app-") {
            guard let pid = Int32(name.dropFirst(4)) else { continue }
            _ = try NativeFileLock.pruneExitedProcess(pid, lock: lockPath(name), data: directory.appendingPathComponent(name + ".revision"))
        }
    }

    static func revision(_ pid: Int32) throws -> UInt64 {
        let file = directory.appendingPathComponent("app-\(pid).revision")
        let data: Data
        do { data = try Data(contentsOf: file) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return 0 }
        guard let value = UInt64(String(decoding: data, as: UTF8.self)) else { throw ComputerFailure("resource_unavailable", "The native app revision is invalid.") }
        return value
    }

    func advanceRevision(_ pid: Int32) throws {
        precondition(names.contains("app-\(pid)"), "An application mutation requires its process lock")
        let previous = try Self.revision(pid)
        guard previous < UInt64.max else { throw ComputerFailure("resource_unavailable", "The native app revision overflowed.") }
        try Data(String(previous + 1).utf8).write(to: Self.directory.appendingPathComponent("app-\(pid).revision"), options: .atomic)
    }

    private static func lockPath(_ name: String) -> URL {
        directory.appendingPathComponent(name + ".lock")
    }

    static func tryAcquire(_ name: String) throws -> NativeResources? {
        try preparation.get()
        guard let lock = try NativeFileLock.tryAcquire(lockPath(name)) else { return nil }
        let lease = NativeResources()
        lease.locks.append(lock)
        lease.names.insert(name)
        return lease
    }

    static func acquire(_ names: [String]) async throws -> NativeResources {
        try preparation.get()
        let lease = NativeResources()
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        for name in Set(names).sorted() {
            lease.locks.append(try await NativeFileLock.acquire(lockPath(name), deadline: deadline))
            lease.names.insert(name)
        }
        return lease
    }
}
