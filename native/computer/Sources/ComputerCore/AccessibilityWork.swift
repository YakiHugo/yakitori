import Foundation

private let accessibilityWorkQueue = DispatchQueue(label: "com.yakitori.computer.accessibility", qos: .userInitiated)

final class AccessibilityCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func check() throws {
        if lock.withLock({ cancelled }) { throw CancellationError() }
    }

    fileprivate func cancel() { lock.withLock { cancelled = true } }
}

func runAccessibilityWork<T>(_ work: @escaping (AccessibilityCancellation) throws -> T) async throws -> T {
    let cancellation = AccessibilityCancellation()
    return try await withTaskCancellationHandler {
        let value = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            accessibilityWorkQueue.async {
                continuation.resume(with: Result {
                    try cancellation.check()
                    return try work(cancellation)
                })
            }
        }
        try Task.checkCancellation()
        return value
    } onCancel: {
        cancellation.cancel()
    }
}
