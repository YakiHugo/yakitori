import Foundation
import Darwin

// MCP connections own separate helpers. OS input and the clipboard remain
// shared resources, so serialization must cross the process boundary.
final class NativeResources {
    private var descriptors: [Int32] = []
    private var names = Set<String>()

    private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Yakitori/Computer/locks")
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

    private static func openLock(_ name: String) throws -> Int32 {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(directory.appendingPathComponent(name + ".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ComputerFailure("resource_unavailable", "Could not open the native resource lock.") }
        return fd
    }

    static func tryAcquire(_ name: String) throws -> NativeResources? {
        let lease = NativeResources()
        let fd = try openLock(name)
        lease.descriptors.append(fd)
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw ComputerFailure("resource_unavailable", "Could not inspect the native resource lock.") }
            return nil
        }
        lease.names.insert(name)
        return lease
    }

    static func acquire(_ names: [String]) async throws -> NativeResources {
        let lease = NativeResources()
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        for name in Set(names).sorted() {
            let descriptor = try openLock(name)
            lease.descriptors.append(descriptor)
            while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
                guard errno == EWOULDBLOCK || errno == EAGAIN else { throw ComputerFailure("resource_unavailable", "Could not lock the native resource.") }
                // Bound lock contention, not operation duration or a product quota.
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerFailure("resource_busy", "Another helper is using this native resource; no input was sent.") }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            try Task.checkCancellation()
            lease.names.insert(name)
        }
        return lease
    }

    deinit {
        for descriptor in descriptors.reversed() { flock(descriptor, LOCK_UN); close(descriptor) }
    }
}
