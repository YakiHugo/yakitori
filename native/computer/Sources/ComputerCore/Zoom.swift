import AppKit
import ScreenCaptureKit

func zoomRegion(_ args: [String: Any], snapshot: Snapshot) throws -> CGRect {
    guard let width = snapshot.imageWidth, let height = snapshot.imageHeight else {
        throw ComputerFailure("coordinates_unavailable", "zoom requires a screenshot observation.")
    }
    var values: [Double] = []
    for key in ["x1", "y1", "x2", "y2"] {
        guard let number = args[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
            throw ComputerFailure("invalid_coordinates", "zoom requires finite screenshot-pixel x1/y1/x2/y2 corners.")
        }
        values.append(number.doubleValue)
    }
    let x = values[0], y = values[1], right = values[2], bottom = values[3]
    guard x >= 0, y >= 0, right > x, bottom > y, right <= Double(width), bottom <= Double(height) else {
        throw ComputerFailure("invalid_coordinates", "The zoom rectangle must be nonempty and inside the observed screenshot.")
    }
    return CGRect(x: snapshot.frame.minX + x * snapshot.frame.width / Double(width),
        y: snapshot.frame.minY + y * snapshot.frame.height / Double(height),
        width: (right - x) * snapshot.frame.width / Double(width), height: (bottom - y) * snapshot.frame.height / Double(height))
}

extension Computer {
    func zoom(_ args: [String: Any]) async throws -> [String: Any] {
        let previous = lastObservation
        snapshot = nil; lastObservation = nil
        guard let previous, args["snapshot_id"] as? String == previous.id else {
            throw ComputerFailure("stale_snapshot", "zoom requires the last screenshot's snapshot_id.")
        }
        let region = try zoomRegion(args, snapshot: previous)
        let recognize = try recognitionEnabled(args, mode: .vision)
        let dimension = args["max_dimension"] as? Int ?? 512
        // The same 1024-pixel reply allocation boundary as observe keeps a
        // worst-case RGBA PNG plus base64 inside the host's 8 MiB MCP frame.
        guard (1...1024).contains(dimension), args["max_dimension"] == nil ||
                (args["max_dimension"] is Int && (args["max_dimension"] as? NSNumber).map { CFGetTypeID($0) != CFBooleanGetTypeID() } == true) else {
            throw ComputerFailure("invalid_arguments", "max_dimension must be within the 1024-pixel observation reply safety boundary.")
        }
        guard CGPreflightScreenCaptureAccess() else { throw ComputerFailure("permission_required", "Screen Recording is required to capture a fresh zoom.") }
        try previous.validate(id: previous.id, windows: windows(), displays: displays())
        let scale = Double(dimension) / max(region.width, region.height)
        let canvas = try ObservationCanvas(frame: region, width: max(1, Int(region.width * scale)), height: max(1, Int(region.height * scale)))
        let shareable: SCShareableContent = try await nativeRequest { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
                if let error { done(.failure(error)) }
                else if let content { done(.success(content)) }
                else { done(.failure(ComputerFailure("capture_failed", "macOS returned no capture sources."))) }
            }
        }
        var nativeCaptures: [[String: Any]] = []
        func layer(_ filter: SCContentFilter, frame: CGRect, windowID: UInt32? = nil) async throws {
            let width = ceil(frame.width * Double(filter.pointPixelScale))
            let height = ceil(frame.height * Double(filter.pointPixelScale))
            // Single-window capture ignores sourceRect. Bound one temporary
            // native RGBA image to 64 MiB, crop it, and release it before the
            // next window instead of retaining a full-resolution app composite.
            guard width.isFinite, height.isFinite, width > 0, height > 0, width * height <= 16_777_216 else {
                throw ComputerFailure("capture_too_large", "The native source exceeds the 64 MiB temporary capture allocation boundary; reduce the target window size.")
            }
            let image = try await capture(filter, width: Int(width), height: Int(height))
            let overlap = frame.intersection(region)
            guard !overlap.isNull else { return }
            let sx = Double(image.width) / frame.width, sy = Double(image.height) / frame.height
            let pixels = CGRect(x: (overlap.minX - frame.minX) * sx, y: (overlap.minY - frame.minY) * sy,
                width: overlap.width * sx, height: overlap.height * sy).integral
            guard let cropped = image.cropping(to: pixels) else { throw ComputerFailure("capture_failed", "The native source could not be cropped.") }
            let actual = CGRect(x: frame.minX + pixels.minX / sx, y: frame.minY + pixels.minY / sy,
                width: Double(cropped.width) / sx, height: Double(cropped.height) / sy)
            canvas.draw(cropped, bounds: actual)
            var evidence: [String: Any] = ["width": image.width, "height": image.height]
            if let windowID { evidence["window_id"] = windowID }
            nativeCaptures.append(evidence)
        }
        if let display = previous.display {
            guard let source = shareable.displays.first(where: { $0.displayID == display.id }) else {
                throw ComputerFailure("display_not_found", "The observed display disappeared.")
            }
            try await layer(SCContentFilter(display: source, excludingWindows: []), frame: display.frame)
        } else {
            for window in previous.windows.reversed() where window.frame.intersects(region) {
                try Task.checkCancellation()
                guard let source = shareable.windows.first(where: { $0.windowID == window.windowID && $0.owningApplication?.processID == window.pid }),
                      source.frame == window.frame else { throw ComputerFailure("stale_snapshot", "A zoom source changed during capture.") }
                try await layer(SCContentFilter(desktopIndependentWindow: source), frame: window.frame, windowID: window.windowID)
            }
        }
        try Task.checkCancellation()
        try previous.validate(id: previous.id, windows: windows(), displays: displays())
        let image = try canvas.image()
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ComputerFailure("capture_failed", "macOS could not encode the zoom image.")
        }
        let selected = previous.scope == .screen ? previous.windows.filter { $0.frame.intersects(region) } : previous.windows
        var next = Snapshot(scope: previous.scope, frame: region, windows: selected, display: previous.display,
            imageWidth: image.width, imageHeight: image.height, elements: [])
        next.mode = .vision; next.revisions = previous.revisions
        var recognitionTruncated = false
        if recognize {
            let recognized = try await recognizeText(image)
            next.textRegions = recognized.regions
            recognitionTruncated = recognized.truncated
        }
        try Task.checkCancellation()
        try next.validate(id: next.id, windows: windows(), displays: displays())
        snapshot = next; lastObservation = next
        var data: [String: Any] = ["snapshot_id": next.id, "source_snapshot_id": previous.id, "scope": next.scope.rawValue,
            "mode": "vision", "frame": frameData(region), "image_width": image.width, "image_height": image.height,
            "windows": selected.map { ["pid": $0.pid, "window_id": $0.windowID, "frame": frameData($0.frame)] as [String: Any] },
            "elements": [], "tree_truncated": false, "accessibility": AXIsProcessTrusted(), "native_captures": nativeCaptures]
        if next.scope != .screen { data["pid"] = selected.first?.pid }
        if next.scope == .window { data["window_id"] = selected.first?.windowID }
        if let display = next.display { data["display_id"] = display.id }
        if recognize { data["text_regions"] = next.textRegions.map(\.data); data["text_regions_truncated"] = recognitionTruncated }
        return try result(data, image: png)
    }
}
