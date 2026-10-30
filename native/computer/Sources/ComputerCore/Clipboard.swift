import AppKit

enum PasteFormat: String { case text, markdown, html }

func pasteboardItem(_ args: [String: Any]) throws -> NSPasteboardItem {
    guard let text = args["text"] as? String,
          let format = PasteFormat(rawValue: args["format"] as? String ?? "text") else {
        throw ComputerFailure("invalid_arguments", "paste requires text and format=text/markdown/html.")
    }
    let item = NSPasteboardItem()
    switch format {
    case .text: item.setString(text, forType: .string)
    case .markdown:
        let attributed = NSMutableAttributedString(attributedString: try NSAttributedString(markdown: Data(text.utf8), options: .init()))
        // Markdown intent attributes are not font attributes. Materialize them
        // before RTF export, otherwise rich editors receive unformatted text.
        attributed.enumerateAttribute(.inlinePresentationIntent, in: NSRange(location: 0, length: attributed.length)) { value, range, _ in
            let intent = InlinePresentationIntent(rawValue: (value as? NSNumber)?.uintValue ?? 0)
            var font = intent.contains(.code) ? NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular) : NSFont.systemFont(ofSize: NSFont.systemFontSize)
            if intent.contains(.stronglyEmphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
            attributed.addAttribute(.font, value: font, range: range)
            if intent.contains(.strikethrough) { attributed.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
        }
        item.setString(attributed.string, forType: .string)
        item.setString(text, forType: NSPasteboard.PasteboardType("net.daringfireball.markdown"))
        item.setData(try attributed.data(from: NSRange(location: 0, length: attributed.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]), forType: .rtf)
    case .html:
        // Do not render supplied HTML to derive text: AppKit's HTML importer can
        // load remote resources. The caller supplies a deterministic fallback.
        guard let fallback = args["plain_text"] as? String else { throw ComputerFailure("invalid_arguments", "HTML paste requires plain_text as its fallback.") }
        item.setString(fallback, forType: .string)
        item.setString(text, forType: .html)
    }
    return item
}

@MainActor func withPasteContent<T>(_ item: NSPasteboardItem, board: NSPasteboard = .general, body: () async throws -> T) async throws -> T {
    let resource = try await NativeResources.acquire(["clipboard"])
    defer { withExtendedLifetime(resource) {} }
    let previous = (board.pasteboardItems ?? []).map { original in
        let copy = NSPasteboardItem()
        for type in original.types { if let data = original.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    }
    board.clearContents()
    guard board.writeObjects([item]) else {
        board.clearContents()
        if !previous.isEmpty { board.writeObjects(previous) }
        throw ComputerFailure("clipboard_failed", "Could not publish paste content; no paste shortcut was sent.")
    }
    let revision = board.changeCount
    func restore() async {
        // The target reads queued CMD+V asynchronously. Cancellation must not
        // restore the user's old clipboard into an already delivered paste.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { continuation.resume() }
        }
        if board.changeCount == revision {
            board.clearContents()
            if !previous.isEmpty { board.writeObjects(previous) }
        }
    }
    do {
        try Task.checkCancellation()
        let value = try await body()
        await restore()
        return value
    } catch {
        await restore()
        throw error
    }
}
