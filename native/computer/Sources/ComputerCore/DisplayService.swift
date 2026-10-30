import AppKit
import Darwin
import DisplayBridge

struct IsolationReady: Codable {
    let displayID: UInt32
    let servicePID: Int32
}

func displayIsOnline(_ id: UInt32) throws -> Bool {
    // CGDisplayIsOnline returns UINT32_MAX for a removed virtual display on
    // macOS 26. Enumerate actual IDs so a stale ID cannot keep recovery waiting.
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success else {
        throw ComputerFailure("display_list_failed", "macOS could not list online displays.")
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &ids, &count) == .success else {
        throw ComputerFailure("display_list_failed", "macOS could not list online displays.")
    }
    return ids.prefix(Int(count)).contains(id)
}

func isolationDisplayReady() throws -> IsolationReady? {
    let data: Data
    do { data = try Data(contentsOf: IsolationFiles.ready) }
    catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile { return nil }
    let ready = try JSONDecoder().decode(IsolationReady.self, from: data)
    guard try displayIsOnline(ready.displayID),
          CGDisplayVendorNumber(ready.displayID) == 0x796b, CGDisplayModelNumber(ready.displayID) == 0x4355,
          kill(ready.servicePID, 0) == 0 else { return nil }
    return ready
}

@MainActor public func runDisplayService() async throws -> Never {
    try IsolationFiles.prepare()
    let lock = open(IsolationFiles.serviceLock.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw ComputerFailure("display_failed", "Could not open the display service lock.") }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { close(lock); exit(0) }
    defer { flock(lock, LOCK_UN); close(lock) }
    if FileManager.default.fileExists(atPath: IsolationFiles.ready.path) { try FileManager.default.removeItem(at: IsolationFiles.ready) }
    let original = try displays()
    let width = min(4096, max(1440, Int(original.map(\.frame.width).max() ?? 1440) + 64))
    let height = min(2304, max(900, Int(original.map(\.frame.height).max() ?? 900) + 64))
    // One 1x virtual backing store stays below 40 MiB RGBA. Oversized windows
    // fail explicitly instead of allocating an unbounded virtual desktop.
    guard let created = YKDisplayCreate(UInt32(width), UInt32(height)) else {
        throw ComputerFailure("isolation_unsupported", "This macOS release could not create the bounded virtual display.")
    }
    var handle: UnsafeMutableRawPointer? = created
    defer { if let handle { YKDisplayDestroy(handle) } }
    let id = YKDisplayIdentifier(created)
    let deadline = ProcessInfo.processInfo.systemUptime + 5
    while !(try displays().contains { $0.id == id }) {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerFailure("display_failed", "The virtual display did not become online.") }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success, let config else { throw ComputerFailure("display_failed", "Could not begin display arrangement.") }
    var configured = false
    defer { if !configured { CGCancelDisplayConfiguration(config) } }
    for display in original {
        guard CGConfigureDisplayOrigin(config, display.id, Int32(display.frame.minX), Int32(display.frame.minY)) == .success else { throw ComputerFailure("display_failed", "Could not preserve an existing display origin.") }
    }
    let x = Int32(original.map(\.frame.maxX).max() ?? 0) + 32
    let y = Int32(original.map(\.frame.maxY).max() ?? 0) + 32
    guard CGConfigureDisplayOrigin(config, id, x, y) == .success,
          CGCompleteDisplayConfiguration(config, .forSession) == .success else { throw ComputerFailure("display_failed", "Could not place the isolated display.") }
    configured = true
    let ready = try JSONEncoder().encode(IsolationReady(displayID: id, servicePID: getpid()))
    try ready.write(to: IsolationFiles.ready, options: .atomic)
    var idleSince: TimeInterval?
    while true {
        guard try displayIsOnline(id) else {
            try FileManager.default.removeItem(at: IsolationFiles.ready)
            throw ComputerFailure("display_failed", "The isolated display went offline; WindowServer returns its windows to physical displays.")
        }
        let status = try await recoverIsolationLeases()
        if status.live == 0 && status.pending == 0 {
            idleSince = idleSince ?? ProcessInfo.processInfo.systemUptime
            if ProcessInfo.processInfo.systemUptime - idleSince! >= 2 {
                // Withdraw readiness before the final lease scan. A concurrent
                // acquirer publishes its locked lease before reading readiness.
                try FileManager.default.removeItem(at: IsolationFiles.ready)
                let final = try await recoverIsolationLeases()
                if final.live == 0 && final.pending == 0 {
                    // Removing the display itself can cause a second desktop
                    // reassignment. Stay alive to reconcile retired journals
                    // after WindowServer has completed that outer transition.
                    YKDisplayDestroy(created)
                    handle = nil
                    let cleanupDeadline = ProcessInfo.processInfo.systemUptime + 5
                    while try displayIsOnline(id) {
                        guard ProcessInfo.processInfo.systemUptime < cleanupDeadline else { throw ComputerFailure("display_failed", "Display removal did not settle; restoration journals remain available.") }
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    while true {
                        if try await recoverIsolationLeases().pending == 0 { exit(0) }
                        guard ProcessInfo.processInfo.systemUptime < cleanupDeadline else { throw ComputerFailure("restoration_failed", "Post-display restoration remains pending in the recovery journals.") }
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                }
                try ready.write(to: IsolationFiles.ready, options: .atomic)
                idleSince = nil
            }
        } else { idleSince = nil }
        try await Task.sleep(nanoseconds: 250_000_000)
    }
}
