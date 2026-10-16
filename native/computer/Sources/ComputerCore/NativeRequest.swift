import Foundation

// ScreenCaptureKit callbacks can outlive a cancelled tool. Resume the caller
// once on cancellation/timeout and ignore late native callbacks, so turn cleanup
// cannot sit behind an uncancellable capture operation indefinitely.
private final class NativeReply<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
        } else {
            self.continuation = continuation
            lock.unlock()
        }
    }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

func nativeRequest<Value>(timeout: TimeInterval = 8, start: (@escaping (Result<Value, Error>) -> Void) -> Void) async throws -> Value {
    let reply = NativeReply<Value>()
    // Bound a stuck OS request, not task duration. Cancellation remains immediate.
    let deadline = DispatchWorkItem { reply.finish(.failure(ComputerFailure("native_timeout", "macOS did not finish the capture request; observe again."))) }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    defer { deadline.cancel() }
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            reply.install(continuation)
            if Task.isCancelled { reply.finish(.failure(CancellationError())); return }
            start { reply.finish($0) }
        }
    } onCancel: {
        reply.finish(.failure(CancellationError()))
    }
}
