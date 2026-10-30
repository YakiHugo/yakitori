import AppKit
import ImageIO
import UniformTypeIdentifiers

// Implementation allocation boundaries for replies and image decoding, using
// the same 64 MiB raster boundary as the capture pipeline.
private let clipboardBytes = 8 * 1024 * 1024
private let clipboardTextBytes = 256 * 1024
private let clipboardItems = 64

private func clipboardImage(_ data: Data, pngOnly: Bool = false) throws -> CGImageSource {
    guard data.count <= clipboardBytes, let source = CGImageSourceCreateWithData(data as CFData, nil),
          !pngOnly || CGImageSourceGetType(source) == UTType.png.identifier as CFString,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
          width.isFinite, height.isFinite, width >= 1, height >= 1, width * height <= 16_777_216 else {
        throw ComputerFailure("clipboard_image_invalid", "Clipboard images require readable raster data within the 8 MiB encoded / 64 MiB decoded allocation boundary; writes require PNG.")
    }
    if pngOnly, CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1,
    ] as CFDictionary) == nil {
        throw ComputerFailure("clipboard_image_invalid", "The supplied PNG cannot be decoded; no clipboard change was made.")
    }
    return source
}

@MainActor func clipboardAccess(_ args: [String: Any], board: NSPasteboard = .general) async throws -> [String: Any] {
    guard let action = args["clipboard_action"] as? String, ["read", "write", "clear"].contains(action) else {
        throw ComputerFailure("invalid_arguments", "clipboard requires clipboard_action=read/write/clear.")
    }
    let resource = try await NativeResources.acquire(["clipboard"])
    defer { withExtendedLifetime(resource) {} }
    try Task.checkCancellation()
    if action == "read" {
        let formats = args["clipboard_formats"] as? [String] ?? ["text"]
        guard args["clipboard_formats"] == nil || args["clipboard_formats"] is [String],
              !formats.isEmpty, Set(formats).count == formats.count,
              Set(formats).isSubset(of: ["text", "html", "rtf", "image", "files"]) else {
            throw ComputerFailure("invalid_arguments", "clipboard_formats requires unique text/html/rtf/image/files entries.")
        }
        let revision = board.changeCount
        let items = board.pasteboardItems ?? []
        guard items.count <= clipboardItems else { throw ComputerFailure("clipboard_limit", "Clipboard item count exceeds the 64-item enumeration safety boundary.") }
        var rows: [[String: Any]] = [], images: [[String: Any]] = []
        var textBytes = 0, bytes = 0, imageReplyBytes = 0
        for (index, item) in items.enumerated() {
            try Task.checkCancellation()
            guard item.types.count <= 64 else {
                throw ComputerFailure("clipboard_limit", "Clipboard type metadata exceeds its enumeration safety boundary.")
            }
            let metadataBytes = item.types.reduce(0, { $0 + $1.rawValue.utf8.count })
            guard metadataBytes <= clipboardTextBytes - textBytes else { throw ComputerFailure("clipboard_limit", "Clipboard type metadata exceeds its reply safety boundary.") }
            textBytes += metadataBytes
            var row: [String: Any] = ["index": index, "types": item.types.map(\.rawValue)]
            for (format, type) in [("text", NSPasteboard.PasteboardType.string), ("html", .html), ("rtf", .rtf), ("files", .fileURL)] where formats.contains(format) {
                guard let data = item.data(forType: type) else {
                    guard !item.types.contains(type) else { throw ComputerFailure("clipboard_unavailable", "An advertised clipboard representation could not be read.") }
                    continue
                }
                guard data.count <= clipboardTextBytes - textBytes else { throw ComputerFailure("clipboard_limit", "Requested clipboard text/RTF exceeds the 256 KiB reply safety boundary; request fewer formats.") }
                textBytes += data.count
                if format == "rtf" { row["rtf_base64"] = data.base64EncodedString() }
                else if format == "files" {
                    guard let value = item.string(forType: type), let url = URL(string: value), url.isFileURL else {
                        throw ComputerFailure("clipboard_unavailable", "The clipboard file reference is not a readable file URL.")
                    }
                    row["file_url"] = url.absoluteString
                } else if let value = item.string(forType: type) { row[format] = value }
                else { throw ComputerFailure("clipboard_unavailable", "The requested clipboard text encoding could not be read.") }
            }
            if formats.contains("image"), let data = item.data(forType: .png) ?? item.data(forType: .tiff) {
                guard data.count <= clipboardBytes - bytes else { throw ComputerFailure("clipboard_limit", "Requested clipboard image data exceeds the 8 MiB aggregate allocation boundary.") }
                bytes += data.count
                let source = try clipboardImage(data)
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1024,
                ] as CFDictionary) else {
                    throw ComputerFailure("clipboard_image_invalid", "Could not produce a bounded clipboard image preview.")
                }
                // ImageIO thumbnails can have indexed color spaces that AppKit
                // cannot encode faithfully. Normalize the preview to RGB first.
                let frame = CGRect(x: 0, y: 0, width: image.width, height: image.height)
                let canvas = try ObservationCanvas(frame: frame, width: image.width, height: image.height)
                canvas.draw(image, bounds: frame)
                guard let png = NSBitmapImageRep(cgImage: try canvas.image()).representation(using: .png, properties: [:]) else {
                    throw ComputerFailure("clipboard_image_invalid", "Could not encode the clipboard image preview.")
                }
                guard png.count <= clipboardBytes - imageReplyBytes else { throw ComputerFailure("clipboard_limit", "Clipboard image previews exceed the reply allocation boundary.") }
                imageReplyBytes += png.count
                row["image"] = ["width": image.width, "height": image.height, "content_index": images.count + 1]
                images.append(["type": "image", "mimeType": "image/png", "data": png.base64EncodedString()])
            } else if formats.contains("image"), item.types.contains(.png) || item.types.contains(.tiff) {
                throw ComputerFailure("clipboard_unavailable", "The advertised clipboard image could not be read.")
            }
            rows.append(row)
        }
        guard board.changeCount == revision else { throw ComputerFailure("clipboard_changed", "Clipboard contents changed during reading; no mixed snapshot was returned.") }
        let data: [String: Any] = ["clipboard_revision": revision, "items": rows]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), as: UTF8.self)
        return ["structuredContent": data, "content": [["type": "text", "text": text]] + images]
    }
    var objects: [NSPasteboardWriting] = []
    if action == "write" {
        let format = args["format"] as? String ?? "text"
        switch format {
        case "text", "markdown", "html":
            guard let text = args["text"] as? String, text.utf8.count <= clipboardTextBytes,
                  (args["plain_text"] as? String ?? "").utf8.count <= clipboardTextBytes else {
                throw ComputerFailure("clipboard_limit", "Clipboard text requires text within the 256 KiB allocation boundary.")
            }
            objects = [try pasteboardItem(args)]
        case "rtf", "image":
            let key = format == "rtf" ? "rtf_base64" : "png_base64"
            guard let encoded = args[key] as? String, encoded.utf8.count <= (clipboardBytes + 2) / 3 * 4,
                  let data = Data(base64Encoded: encoded), data.count <= clipboardBytes else {
                throw ComputerFailure("invalid_arguments", "\(format) requires \(key) within the 8 MiB decoded allocation boundary.")
            }
            if format == "image" { _ = try clipboardImage(data, pngOnly: true) }
            let item = NSPasteboardItem()
            guard item.setData(data, forType: format == "rtf" ? .rtf : .png) else { throw ComputerFailure("clipboard_failed", "Could not prepare the clipboard representation.") }
            objects = [item]
        case "files":
            guard let paths = args["file_paths"] as? [String], !paths.isEmpty, paths.count <= clipboardItems,
                  paths.reduce(0, { $0 + $1.utf8.count }) <= clipboardTextBytes else {
                throw ComputerFailure("invalid_arguments", "files requires 1...64 absolute file_paths within the clipboard text allocation boundary.")
            }
            objects = try paths.map { path -> NSURL in
                guard path.hasPrefix("/"), !path.utf8.contains(0), FileManager.default.fileExists(atPath: path) else {
                    throw ComputerFailure("invalid_arguments", "Every clipboard file path must be absolute and exist; no clipboard change was made.")
                }
                return URL(fileURLWithPath: path) as NSURL
            }
        default: throw ComputerFailure("invalid_arguments", "Clipboard writes support text/markdown/html/rtf/image/files.")
        }
    }
    var preparedBytes = 0
    for item in objects.compactMap({ $0 as? NSPasteboardItem }) {
        for type in item.types {
            guard let data = item.data(forType: type), data.count <= clipboardBytes - preparedBytes else {
                throw ComputerFailure("clipboard_limit", "Prepared clipboard formats exceed the 8 MiB aggregate allocation boundary; no change was made.")
            }
            preparedBytes += data.count
        }
    }
    try Task.checkCancellation()
    board.clearContents()
    guard objects.isEmpty || board.writeObjects(objects) else { throw ComputerFailure("clipboard_failed", "Clipboard publication failed after clearing it; inspect before continuing.") }
    return ["structuredContent": ["clipboard_revision": board.changeCount, "effect": action == "clear" ? "clipboard_cleared" : "clipboard_written"],
        "content": [["type": "text", "text": "Clipboard \(action == "clear" ? "cleared" : "written"); this intentional change is not automatically restored."]]]
}
