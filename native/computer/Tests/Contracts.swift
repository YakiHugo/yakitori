import AppKit
import ApplicationServices
import Foundation

// The macOS Command Line Tools ship no XCTest/Testing runtime. Compile these
// process-failing contracts with the core sources so CI needs no full Xcode.
@main struct Contracts {
    static func rejects(code: String? = nil, file: StaticString = #fileID, line: UInt = #line, _ operation: () throws -> Void) {
        do { try operation(); fatalError("Expected a ComputerFailure", file: file, line: line) }
        catch let failure as ComputerFailure { if let code { precondition(failure.code == code, "Expected \(code), received \(failure.code)") } }
        catch { fatalError("Unexpected error: \(error)") }
    }

    static func main() async throws {
        let window = WindowIdentity(pid: 42, launched: Date(timeIntervalSince1970: 100), windowID: 7, frame: CGRect(x: -300, y: 50, width: 400, height: 200), layer: 0)
        let snapshot = Snapshot(scope: .window, frame: window.frame, windows: [window], display: nil, imageWidth: 800, imageHeight: 400, elements: [])
        let point = try snapshot.point(x: 200, y: 100)
        precondition(point == CGPoint(x: -200, y: 100))
        rejects { _ = try snapshot.point(x: 800, y: 0) }
        rejects { _ = try snapshot.point(x: 0, y: -1) }
        rejects { _ = try snapshot.point(x: .nan, y: 0) }
        try snapshot.validate(id: snapshot.id, windows: [window], displays: [])
        rejects { try snapshot.validate(id: "old", windows: [window], displays: []) }
        let relaunched = WindowIdentity(pid: 42, launched: Date(timeIntervalSince1970: 200), windowID: 7, frame: window.frame, layer: 0)
        rejects { try snapshot.validate(id: snapshot.id, windows: [relaunched], displays: []) }
        let moved = WindowIdentity(pid: 42, launched: window.launched, windowID: 7, frame: CGRect(x: 0, y: 0, width: 400, height: 200), layer: 0)
        rejects { try snapshot.validate(id: snapshot.id, windows: [moved], displays: []) }
        let other = WindowIdentity(pid: 42, launched: window.launched, windowID: 8, frame: CGRect(x: 100, y: 250, width: 200, height: 200), layer: 0)
        let appSnapshot = Snapshot(scope: .app, frame: CGRect(x: -300, y: 50, width: 600, height: 400), windows: [window, other], display: nil,
            imageWidth: 1200, imageHeight: 800, elements: [])
        let appPoint = try appSnapshot.point(x: 1000, y: 600)
        precondition(appPoint == CGPoint(x: 200, y: 350))
        let pixelTarget = try appSnapshot.target(["x": 1000.0, "y": 600.0])
        precondition(pixelTarget.window == other && pixelTarget.point == CGPoint(x: 200, y: 350))
        rejects(code: "invalid_coordinates") { _ = try appSnapshot.target(["x": 900.0, "y": 200.0]) }
        rejects(code: "invalid_arguments") { _ = try appSnapshot.target(["x": 100.0]) }
        rejects(code: "invalid_arguments") { _ = try appSnapshot.target(["x": "100", "y": 100.0]) }
        rejects(code: "invalid_arguments") { _ = try appSnapshot.target(["element": 0, "x": 100.0, "y": 100.0]) }
        let owned = Snapshot(scope: .app, frame: appSnapshot.frame, windows: [window, other], display: nil,
            imageWidth: 1200, imageHeight: 800, elements: [ObservedElement(value: AXUIElementCreateApplication(42), window: other)])
        let elementTarget = try owned.target(["element": 0])
        precondition(elementTarget.window == other && elementTarget.element != nil && elementTarget.point == nil)
        rejects(code: "invalid_element") { _ = try owned.target(["element": "0"]) }
        rejects(code: "invalid_element") { _ = try owned.target(["element": 1]) }
        try appSnapshot.validate(id: appSnapshot.id, windows: [window, other], displays: [])
        rejects { try appSnapshot.validate(id: appSnapshot.id, windows: [window], displays: []) }
        rejects { try appSnapshot.validate(id: appSnapshot.id, windows: [other, window], displays: []) }
        let display = DisplayIdentity(id: 5, frame: CGRect(x: -1000, y: 0, width: 1600, height: 900))
        let screen = Snapshot(scope: .screen, frame: display.frame, windows: [window, other], display: display,
            imageWidth: 800, imageHeight: 450, elements: [])
        let screenPoint = try screen.point(x: 500, y: 200)
        precondition(screenPoint == CGPoint(x: 0, y: 400))
        let desktopTarget = try screen.target(["x": 0.0, "y": 0.0])
        precondition(desktopTarget.window == nil && desktopTarget.point == CGPoint(x: -1000, y: 0))
        try screen.validate(id: screen.id, windows: [window, other], displays: [display])
        rejects { try screen.validate(id: screen.id, windows: [window, other], displays: []) }
        let textOnly = Snapshot(scope: .window, frame: window.frame, windows: [window], display: nil, imageWidth: nil, imageHeight: nil, elements: [])
        rejects { _ = try textOnly.point(x: 0, y: 0) }
        let path = try menuPath(["File", "Open"])
        precondition(path == ["File", "Open"])
        rejects { _ = try menuPath([] as [String]) }
        rejects { _ = try menuPath([" "]) }
        rejects { _ = try menuPath([1]) }
        rejects { _ = try menuPath(Array(repeating: "Item", count: 17)) }
        try observationContracts()
        try applicationContracts()
        try await advancedContracts()
        let chord = try keyChord("CMD+SHIFT+A")
        precondition(chord.0 == 0 && chord.1 == [.maskCommand, .maskShift])
        rejects { _ = try keyChord("TYPO+A") }
        // Exercise Apple's event bridge without posting input or requesting TCC.
        // Window hit-test fields alone still produce NSEvent.windowNumber == 0.
        let source = CGEventSource(stateID: .privateState)
        let click = CGEvent(mouseEventSource: source, mouseType: .rightMouseDown,
                            mouseCursorPosition: CGPoint(x: -200, y: 100), mouseButton: .right)!
        click.flags = .maskShift
        click.setIntegerValueField(.mouseEventClickState, value: 2)
        let routedClick = try windowPointerEvent(click, window: window)
        let nativeClick = NSEvent(cgEvent: routedClick)!
        precondition(nativeClick.windowNumber == 7 && nativeClick.type == .rightMouseDown)
        precondition(nativeClick.buttonNumber == 1 && nativeClick.clickCount == 2)
        precondition(nativeClick.modifierFlags.contains(.shift) && routedClick.location == CGPoint(x: -200, y: 100))
        let scroll = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: 13, wheel2: -7, wheel3: 0)!
        scroll.location = CGPoint(x: -200, y: 100)
        let nativeScroll = NSEvent(cgEvent: try windowPointerEvent(scroll, window: window))!
        precondition(nativeScroll.windowNumber == 7 && nativeScroll.type == .scrollWheel)
        precondition(nativeScroll.hasPreciseScrollingDeltas && nativeScroll.scrollingDeltaY == 13 && nativeScroll.scrollingDeltaX == -7)
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
        print("Native launch resolution, observation modes/scopes/composition, input identity and cancellation contracts passed.")
    }

    @MainActor static func advancedContracts() async throws {
        let range = try selectedRange(in: "a😀猫猫b", text: "猫", prefix: nil, suffix: "b", kind: .text)
        precondition(range.location == 4 && range.length == 1)
        let cursor = try selectedRange(in: "a😀猫猫b", text: "猫", prefix: "a😀", suffix: nil, kind: .cursorAfter)
        precondition(cursor.location == 4 && cursor.length == 0)
        rejects(code: "ambiguous_text") { _ = try selectedRange(in: "aaaa", text: "aa", prefix: nil, suffix: nil, kind: .text) }
        rejects { _ = try selectedRange(in: "abc", text: "", prefix: nil, suffix: nil, kind: .text) }
        rejects { _ = try AXExpectation(["exists": false]) }
        let clipped = try AXExpectation(["value": "prefix"])
        precondition(!clipped.matches(["value": "prefix", "truncated_attributes": ["value"]]))
        rejects { _ = try inputDuration(["duration": -1]) }
        rejects { _ = try inputModifiers(["unknown"]) }
        rejects { _ = try waitTimeout(["timeout": Double.infinity]) }
        let window = WindowIdentity(pid: 42, launched: nil, windowID: 9, frame: CGRect(x: -300, y: 50, width: 400, height: 200), layer: 0)
        let node = ObservedElement(value: AXUIElementCreateApplication(42), window: window)
        let before = Snapshot(scope: .window, frame: window.frame, windows: [window], display: nil, imageWidth: nil, imageHeight: nil,
            elements: [node], rows: [["element": 0, "role": "AXTextField", "value": "before"]])
        let point = try before.point(x: 500, y: 500, space: "normalized")
        precondition(point == CGPoint(x: -100, y: 150))
        let global = try before.point(x: -200, y: 100, space: "screen")
        precondition(global == CGPoint(x: -200, y: 100))
        rejects { _ = try before.point(x: 1000, y: 0, space: "normalized") }
        rejects { _ = try before.point(x: 1000, y: 0, space: "screen") }
        let after = Snapshot(scope: .window, frame: window.frame, windows: [window], display: nil, imageWidth: nil, imageHeight: nil,
            elements: [node], rows: [["element": 0, "role": "AXTextField", "value": "after"]])
        let diff = after.difference(from: before)
        precondition((diff["updated"] as! [[String: Any]]).count == 1 && (diff["added"] as! [[String: Any]]).isEmpty)
        let absent = try AXExpectation(["title": "missing", "exists": false])
        precondition(absent.satisfied(by: before))
        var partial = before; partial.truncated = true
        precondition(!absent.satisfied(by: partial))
        let computer = Computer()
        computer.lastObservation = after
        let queried = try computer.query(["snapshot_id": after.id, "query": "AFTER", "limit": 1])["structuredContent"] as! [String: Any]
        precondition((queried["elements"] as! [[String: Any]]).count == 1 && queried["input_available"] as? Bool == false)
        rejects { _ = try computer.query(["snapshot_id": before.id]) }
        let board = NSPasteboard(name: .init("yakitori-contract-" + UUID().uuidString))
        defer { board.releaseGlobally() }
        let original = NSPasteboardItem()
        original.setString("original", forType: .string)
        original.setData(Data([1, 2, 3]), forType: .rtf)
        board.clearContents(); precondition(board.writeObjects([original]))
        let item = try pasteboardItem(["text": "**bold**", "format": "markdown"])
        precondition(item.string(forType: .string) == "bold" && item.data(forType: .rtf) != nil)
        try await withPasteContent(item, board: board) { precondition(board.string(forType: .string) == "bold") }
        precondition(board.string(forType: .string) == "original" && board.data(forType: .rtf) == Data([1, 2, 3]))
        try await withPasteContent(try pasteboardItem(["text": "ours"]), board: board) {
            board.clearContents(); board.setString("new writer", forType: .string)
        }
        precondition(board.string(forType: .string) == "new writer")
        do {
            try await withPasteContent(try pasteboardItem(["text": "temporary"]), board: board) { throw CancellationError() }
            preconditionFailure("Cancellation must propagate")
        } catch is CancellationError {}
        precondition(board.string(forType: .string) == "new writer")
        rejects { _ = try pasteboardItem(["text": "<b>hi</b>", "format": "html"]) }
        let html = try pasteboardItem(["text": "<b>hi</b>", "format": "html", "plain_text": "hi"])
        precondition(html.string(forType: .html) == "<b>hi</b>" && html.string(forType: .string) == "hi")
    }

    static func observationContracts() throws {
        let defaults = try ObservationRequest(["pid": 42, "window_id": 7])
        precondition(defaults.mode == .both && defaults.scope == .window)
        for mode in ["ax", "vision", "both"] {
            _ = try ObservationRequest(["mode": mode, "scope": "app", "pid": 42])
            _ = try ObservationRequest(["mode": mode, "scope": "screen", "display_id": 5])
        }
        rejects { _ = try ObservationRequest(["scope": "app", "pid": 42, "window_id": 7]) }
        rejects { _ = try ObservationRequest(["scope": "screen", "pid": 42]) }
        rejects { _ = try ObservationRequest(["scope": "screen", "display_id": "5"]) }
        rejects { _ = try ObservationRequest(["scope": "screen", "display_id": 0]) }
        rejects { _ = try ObservationRequest(["scope": "window", "pid": 42]) }
        rejects { _ = try ObservationRequest(["scope": "app", "pid": 42, "mode": "typo"]) }
        rejects { _ = try ObservationRequest(["scope": "app", "pid": 42, "mode": 1]) }
        rejects { _ = try ObservationRequest(["scope": "typo"]) }
        let background = try ObservationCanvas(frame: CGRect(x: 0, y: 0, width: 2, height: 2), width: 2, height: 2)
        background.context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        background.context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        let foreground = try ObservationCanvas(frame: CGRect(x: 0, y: 0, width: 2, height: 2), width: 2, height: 2)
        foreground.context.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
        foreground.context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        let composite = try ObservationCanvas(frame: CGRect(x: -20, y: 10, width: 4, height: 4), width: 8, height: 8)
        composite.draw(try background.image(), bounds: CGRect(x: -20, y: 10, width: 4, height: 4))
        composite.draw(try foreground.image(), bounds: CGRect(x: -18, y: 10, width: 2, height: 2))
        let pixels = NSBitmapImageRep(cgImage: try composite.image())
        precondition(pixels.colorAt(x: 6, y: 1)!.greenComponent > 0.9)
        precondition(pixels.colorAt(x: 1, y: 1)!.redComponent > 0.9)
        precondition(pixels.colorAt(x: 6, y: 6)!.redComponent > 0.9)
    }

    static func applicationContracts() throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("yakitori-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for directory in ["one/Utilities/Editor.app", "two/Editor.app"] {
            let contents = root.appendingPathComponent(directory).appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: contents.appendingPathComponent("MacOS/editor"))
            let info: [String: Any] = ["CFBundleIdentifier": "test.editor", "CFBundleExecutable": "editor", "CFBundlePackageType": "APPL"]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        }
        let first = root.appendingPathComponent("one/Utilities/Editor.app")
        let found = try applicationURL(.name("editor"), roots: [root.appendingPathComponent("one")], running: [])
        precondition(found == first.standardizedFileURL)
        let direct = try applicationURL(ApplicationTarget(["app_path": first.path]), roots: [], running: [])
        precondition(direct == found)
        let running = try applicationURL(.name("Editor.app"), roots: [], running: [first, first])
        precondition(running == found)
        let byID = try applicationURL(.bundleID("test.editor"), roots: [], running: [first])
        precondition(byID == found)
        rejects(code: "app_ambiguous") { _ = try applicationURL(.name("Editor"), roots: [root], running: []) }
        rejects(code: "app_not_found") { _ = try applicationURL(.name("Edit"), roots: [root], running: []) }
        rejects(code: "invalid_arguments") { _ = try applicationURL(.path("Editor.app"), roots: [], running: []) }
        rejects(code: "app_not_found") { _ = try applicationURL(.path(root.path), roots: [], running: []) }
        rejects { _ = try ApplicationTarget(["bundle_id": "test.editor", "app_name": "Editor"]) }
        rejects { _ = try ApplicationTarget(["app_name": ""]) }
        rejects { _ = try ApplicationTarget(["app_name": "/Applications/Editor.app"]) }
    }
}
