import AppKit
import ScreenCaptureKit

func zoomRegion(_ args: [String: Any], snapshot: Snapshot) throws -> CGRect {
    var values: [Double] = []
    for key in ["x1", "y1", "x2", "y2"] {
        guard let number = args[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
            throw ComputerFailure("invalid_coordinates", "zoom requires finite x1/y1/x2/y2 corners.")
        }
        values.append(number.doubleValue)
    }
    let coordinates: CGRect
    let space = args["coordinate_space"] as? String ?? "screenshot"
    switch space {
    case "screenshot":
        guard let width = snapshot.imageWidth, let height = snapshot.imageHeight else {
            throw ComputerFailure("coordinates_unavailable", "Screenshot coordinates require a vision observation.")
        }
        coordinates = CGRect(x: 0, y: 0, width: width, height: height)
    case "normalized": coordinates = CGRect(x: 0, y: 0, width: 1000, height: 1000)
    case "screen": coordinates = snapshot.frame
    default: throw ComputerFailure("invalid_arguments", "coordinate_space must be screenshot, normalized, or screen.")
    }
    let (x, y, right, bottom) = (values[0], values[1], values[2], values[3])
    guard x >= coordinates.minX, y >= coordinates.minY, right > x, bottom > y,
          right <= coordinates.maxX, bottom <= coordinates.maxY else {
        throw ComputerFailure("invalid_coordinates", "The zoom rectangle must be nonempty and inside the observed frame.")
    }
    let sx = snapshot.frame.width / coordinates.width, sy = snapshot.frame.height / coordinates.height
    return CGRect(x: snapshot.frame.minX + (x - coordinates.minX) * sx,
        y: snapshot.frame.minY + (y - coordinates.minY) * sy, width: (right - x) * sx, height: (bottom - y) * sy)
}

extension Computer {
    func zoom(_ args: [String: Any]) async throws -> [String: Any] {
        let previous = lastObservation
        snapshot = nil; lastObservation = nil
        guard let previous, args["snapshot_id"] as? String == previous.id else {
            throw ComputerFailure("stale_snapshot", "zoom requires the last observation's snapshot_id.")
        }
        let region = try zoomRegion(args, snapshot: previous)
        let dimension = args["max_dimension"] as? Int ?? 512
        guard (1...screenshotDimensionLimit).contains(dimension), args["max_dimension"] == nil ||
                (args["max_dimension"] is Int && (args["max_dimension"] as? NSNumber).map { CFGetTypeID($0) != CFBooleanGetTypeID() } == true) else {
            throw ComputerFailure("invalid_arguments", "max_dimension exceeds the observation reply safety boundary (\(screenshotDimensionLimit) pixels).")
        }
        guard CGPreflightScreenCaptureAccess() else { throw ComputerFailure("permission_required", "Screen Recording is required to capture a fresh zoom.") }
        try previous.validate(id: previous.id, windows: windows(), displays: displays())
        let shareable: SCShareableContent = try await nativeRequest { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
                if let error { done(.failure(error)) }
                else if let content { done(.success(content)) }
                else { done(.failure(ComputerFailure("capture_failed", "macOS returned no capture sources."))) }
            }
        }
        let scale = min(1, Double(dimension) / max(region.width, region.height))
        let canvas = try ObservationCanvas(frame: region, width: max(1, Int(region.width * scale)), height: max(1, Int(region.height * scale)))
        var nativeCaptures: [[String: Any]] = []
        func layer(_ filter: SCContentFilter, frame: CGRect, windowID: UInt32) async throws {
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
            nativeCaptures.append(["width": image.width, "height": image.height, "window_id": windowID])
        }
        if let display = previous.display {
            guard let source = shareable.displays.first(where: { $0.displayID == display.id }) else {
                throw ComputerFailure("display_not_found", "The observed display disappeared.")
            }
            let localCrop = region.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            let image = try await capture(SCContentFilter(display: source, excludingWindows: []),
                width: canvas.context.width, height: canvas.context.height, sourceRect: localCrop)
            canvas.draw(image, bounds: region)
            nativeCaptures.append(["width": image.width, "height": image.height])
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
        let jpeg = try encodeScreenshot(image)
        let selected = previous.scope == .screen ? previous.windows.filter { $0.frame.intersects(region) } : previous.windows
        var next = Snapshot(scope: previous.scope, frame: region, windows: selected, display: previous.display,
            imageWidth: image.width, imageHeight: image.height, elements: [])
        next.mode = .vision; next.revisions = previous.revisions
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
        return try result(data, screenshotJPEG: jpeg)
    }
}
