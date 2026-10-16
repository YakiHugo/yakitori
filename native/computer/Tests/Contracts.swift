import ApplicationServices
import Foundation

// The macOS Command Line Tools ship no XCTest/Testing runtime. Compile these
// process-failing contracts with the core sources so CI needs no full Xcode.
@main struct Contracts {
    static func rejects(_ operation: () throws -> Void) {
        do { try operation(); fatalError("Expected a ComputerFailure") }
        catch is ComputerFailure {}
        catch { fatalError("Unexpected error: \(error)") }
    }

    static func main() async throws {
        let window = WindowIdentity(pid: 42, launched: Date(timeIntervalSince1970: 100), windowID: 7, frame: CGRect(x: -300, y: 50, width: 400, height: 200))
        let snapshot = Snapshot(window: window, imageWidth: 800, imageHeight: 400, elements: [])
        let point = try snapshot.point(x: 200, y: 100)
        precondition(point == CGPoint(x: -200, y: 100))
        rejects { _ = try snapshot.point(x: 800, y: 0) }
        rejects { _ = try snapshot.point(x: 0, y: -1) }
        rejects { _ = try snapshot.point(x: .nan, y: 0) }
        try snapshot.validate(id: snapshot.id, window: window)
        rejects { try snapshot.validate(id: "old", window: window) }
        let relaunched = WindowIdentity(pid: 42, launched: Date(timeIntervalSince1970: 200), windowID: 7, frame: window.frame)
        rejects { try snapshot.validate(id: snapshot.id, window: relaunched) }
        let moved = WindowIdentity(pid: 42, launched: window.launched, windowID: 7, frame: CGRect(x: 0, y: 0, width: 400, height: 200))
        rejects { try snapshot.validate(id: snapshot.id, window: moved) }
        let chord = try keyChord("CMD+SHIFT+A")
        precondition(chord.0 == 0 && chord.1 == [.maskCommand, .maskShift])
        rejects { _ = try keyChord("TYPO+A") }
        let (started, callback) = AsyncStream<(Result<Int, Error>) -> Void>.makeStream()
        let waiting = Task { try await nativeRequest { done in callback.yield(done) } }
        var events = started.makeAsyncIterator()
        let finish = await events.next()!
        callback.finish()
        waiting.cancel()
        do { _ = try await waiting.value; fatalError("Cancelled capture must not wait for a native callback") }
        catch is CancellationError {}
        finish(.success(42)) // A late OS callback must not resume the caller twice.
        let first: Int = try await nativeRequest { done in done(.success(7)); done(.success(9)) }
        precondition(first == 7)
        do {
            let _: Int = try await nativeRequest(timeout: 0.01) { _ in }
            fatalError("A stuck native request must time out")
        } catch let failure as ComputerFailure { precondition(failure.code == "native_timeout") }
        print("Native geometry, observation identity, keyboard and capture cancellation contracts passed.")
    }
}
