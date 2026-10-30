import AppKit

@MainActor func verifyClipboardAccess() async throws {
    let board = NSPasteboard(name: .init("yakitori-clipboard-access-" + UUID().uuidString))
    defer { board.releaseGlobally() }
    func call(_ args: [String: Any]) async throws -> [String: Any] {
        try await clipboardAccess(args, board: board)
    }
    func rows(_ result: [String: Any]) -> [[String: Any]] {
        (result["structuredContent"] as! [String: Any])["items"] as! [[String: Any]]
    }
    _ = try await call(["clipboard_action": "write", "text": "Clipboard 猫😀"])
    let text = try await call(["clipboard_action": "read"])
    precondition(rows(text).count == 1 && rows(text)[0]["text"] as? String == "Clipboard 猫😀")
    _ = try await call(["clipboard_action": "write", "format": "html", "text": "<b>owned</b>", "plain_text": "owned"])
    let html = rows(try await call(["clipboard_action": "read", "clipboard_formats": ["text", "html"]]))
    precondition(html[0]["text"] as? String == "owned" && html[0]["html"] as? String == "<b>owned</b>")
    let rtf = Data("{\\rtf1\\ansi owned}".utf8)
    _ = try await call(["clipboard_action": "write", "format": "rtf", "rtf_base64": rtf.base64EncodedString()])
    let rich = rows(try await call(["clipboard_action": "read", "clipboard_formats": ["rtf"]]))
    precondition(rich[0]["rtf_base64"] as? String == rtf.base64EncodedString())
    let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32)!
    for (index, byte) in [UInt8(255), 0, 0, 255, 0, 0, 255, 255].enumerated() { image.bitmapData![index] = byte }
    let png = image.representation(using: .png, properties: [:])!
    _ = try await call(["clipboard_action": "write", "format": "image", "png_base64": png.base64EncodedString()])
    let captured = try await call(["clipboard_action": "read", "clipboard_formats": ["image"]])
    let contents = captured["content"] as! [[String: Any]]
    precondition(contents.count == 2 && contents[1]["mimeType"] as? String == "image/png")
    let actual = NSBitmapImageRep(data: Data(base64Encoded: contents[1]["data"] as! String)!)!
    precondition(actual.pixelsWide == 2 && actual.pixelsHigh == 1)
    precondition(actual.colorAt(x: 0, y: 0)!.redComponent > 0.99 && actual.colorAt(x: 1, y: 0)!.blueComponent > 0.99)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("yakitori-clipboard-files-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = [root.appendingPathComponent("file with spaces.txt"), root.appendingPathComponent("猫.txt")]
    for path in paths { try Data("owned fixture".utf8).write(to: path) }
    _ = try await call(["clipboard_action": "write", "format": "files", "file_paths": paths.map(\.path)])
    let files = rows(try await call(["clipboard_action": "read", "clipboard_formats": ["files"]]))
    precondition(files.compactMap { $0["file_url"] as? String } == paths.map(\.absoluteString))
    _ = try await call(["clipboard_action": "write", "text": "preserve on refusal"])
    let revision = board.changeCount
    for args: [String: Any] in [
        ["clipboard_action": "write", "format": "image", "png_base64": Data("not PNG".utf8).base64EncodedString()],
        ["clipboard_action": "write", "format": "image", "png_base64": Data(png.prefix(33)).base64EncodedString()],
        ["clipboard_action": "write", "format": "files", "file_paths": ["relative.txt"]],
        ["clipboard_action": "read", "clipboard_formats": ["text", "text"]],
    ] {
        do { _ = try await call(args); preconditionFailure("Invalid clipboard data must fail before mutation") }
        catch is ComputerFailure {}
        precondition(board.changeCount == revision && board.string(forType: .string) == "preserve on refusal")
    }
    _ = try await call(["clipboard_action": "clear"])
    let cleared = try await call(["clipboard_action": "read"])
    precondition(rows(cleared).isEmpty)
    print("Native clipboard text, rich text, raster pixels, file URLs and refusal preservation passed on an isolated pasteboard.")
}
