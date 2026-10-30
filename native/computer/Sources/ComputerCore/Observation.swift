import AppKit
import ApplicationServices
import ScreenCaptureKit

struct ObservationRequest {
    let mode: ObservationMode
    let scope: ObservationScope
    let pid: pid_t?
    let windowID: CGWindowID?
    let displayID: CGDirectDisplayID?

    init(_ args: [String: Any]) throws {
        guard let mode = ObservationMode(rawValue: args["mode"] as? String ?? "both"),
              let scope = ObservationScope(rawValue: args["scope"] as? String ?? "window"),
              args["mode"] == nil || args["mode"] is String,
              args["scope"] == nil || args["scope"] is String else {
            throw ComputerFailure("invalid_arguments", "mode must be ax, vision, or both; scope must be window, app, or screen.")
        }
        self.mode = mode
        self.scope = scope
        pid = (args["pid"] as? Int).flatMap { Int32(exactly: $0) }
        windowID = (args["window_id"] as? Int).flatMap { UInt32(exactly: $0) }
        displayID = (args["display_id"] as? Int).flatMap { UInt32(exactly: $0) }
        switch scope {
        case .window:
            guard let pid, pid > 0, let windowID, windowID > 0, args["display_id"] == nil else {
                throw ComputerFailure("invalid_arguments", "Window scope requires pid and window_id, without display_id.")
            }
        case .app:
            guard let pid, pid > 0, args["window_id"] == nil, args["display_id"] == nil else {
                throw ComputerFailure("invalid_arguments", "App scope requires pid, without window_id or display_id.")
            }
        case .screen:
            guard args["pid"] == nil, args["window_id"] == nil,
                  args["display_id"] == nil || (displayID != nil && displayID != 0) else {
                throw ComputerFailure("invalid_arguments", "Screen scope accepts display_id (default: main display), without pid or window_id.")
            }
        }
    }
}

func displays() throws -> [DisplayIdentity] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success else {
        throw ComputerFailure("display_list_failed", "macOS could not list displays.")
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
        throw ComputerFailure("display_list_failed", "macOS could not list displays.")
    }
    return ids.prefix(Int(count)).map { DisplayIdentity(id: $0, frame: CGDisplayBounds($0)) }
}

func frameData(_ frame: CGRect) -> [String: Double] {
    ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
}

final class ObservationCanvas {
    let context: CGContext
    let frame: CGRect

    init(frame: CGRect, width: Int, height: Int) throws {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ComputerFailure("capture_failed", "macOS could not allocate the observation image.")
        }
        self.context = context
        self.frame = frame
    }

    func draw(_ image: CGImage, bounds: CGRect) {
        let width = Double(context.width), height = Double(context.height)
        context.draw(image, in: CGRect(x: (bounds.minX - frame.minX) * Double(width) / frame.width,
            y: (frame.maxY - bounds.maxY) * Double(height) / frame.height,
            width: bounds.width * Double(width) / frame.width, height: bounds.height * Double(height) / frame.height))
    }

    func image() throws -> CGImage {
        guard let image = context.makeImage() else { throw ComputerFailure("capture_failed", "macOS did not compose the observation image.") }
        return image
    }
}

extension Computer {
    func observe(_ args: [String: Any]) async throws -> [String: Any] {
        // A failed replacement observation must not leave an older input ticket usable.
        let previous = lastObservation
        snapshot = nil
        lastObservation = nil
        let request = try ObservationRequest(args)
        let recognize = try recognitionEnabled(args, mode: request.mode)
        var subtree: ObservedElement?
        if args["root_element"] != nil {
            guard let previous, previous.id == args["snapshot_id"] as? String,
                  let index = args["root_element"] as? Int, previous.elements.indices.contains(index) else {
                throw ComputerFailure("stale_snapshot", "Subtree observation requires root_element from the previous snapshot_id.")
            }
            try previous.validate(id: previous.id, windows: windows(), displays: displays())
            subtree = previous.elements[index]
        }
        if request.mode == .ax && !AXIsProcessTrusted() {
            throw ComputerFailure("permission_required", "Enable Accessibility for AX observations. Screen Recording is not required for mode=ax.")
        }
        if request.mode != .ax && !CGPreflightScreenCaptureAccess() {
            throw ComputerFailure("permission_required", "Enable Screen Recording for vision/both observations, or use mode=ax with Accessibility.")
        }
        let currentWindows = try windows()
        let display: DisplayIdentity?
        let selected: [WindowIdentity]
        let frame: CGRect
        switch request.scope {
        case .window, .app:
            selected = currentWindows.filter { $0.pid == request.pid && (request.scope == .app || $0.windowID == request.windowID) }
            guard !selected.isEmpty else { throw ComputerFailure("window_not_found", "No matching visible windows exist on the current desktop.") }
            frame = selected.dropFirst().reduce(selected[0].frame) { $0.union($1.frame) }
            display = nil
        case .screen:
            guard let found = try displays().first(where: { $0.id == (request.displayID ?? CGMainDisplayID()) }) else {
                throw ComputerFailure("display_not_found", "List displays and provide an active display_id.")
            }
            display = found
            frame = found.frame
            // Transient system overlays (including ScreenCaptureKit's own UI)
            // must not invalidate every display capture as they appear/disappear.
            selected = currentWindows.filter { $0.layer == 0 && $0.frame.intersects(frame) }
        }
        let revisions = try Dictionary(uniqueKeysWithValues: Set(selected.map(\.pid)).map { ($0, try NativeResources.revision($0)) })
        var image: CGImage?
        if request.mode != .ax {
            let shareable: SCShareableContent = try await nativeRequest { done in
                SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
                    if let error { done(.failure(error)) }
                    else if let content { done(.success(content)) }
                    else { done(.failure(ComputerFailure("capture_failed", "macOS returned no window content."))) }
                }
            }
            // Bound one complete reply (PNG plus base64 and AX) to the host's
            // 8 MiB framing boundary. This is an allocation boundary, not a quota.
            let scale = min(1, 1024 / max(frame.width, frame.height))
            let width = max(1, Int(frame.width * scale)), height = max(1, Int(frame.height * scale))
            if let display {
                guard let source = shareable.displays.first(where: { $0.displayID == display.id }) else {
                    throw ComputerFailure("display_not_found", "The display is no longer capturable.")
                }
                image = try await capture(SCContentFilter(display: source, excludingWindows: []), width: width, height: height)
            } else {
                // Application scope composes only its own windows, across their
                // full union frame, without accidentally including other apps.
                let canvas = try ObservationCanvas(frame: frame, width: width, height: height)
                // WindowServer lists front to back. Composite incrementally in
                // reverse order so memory does not grow with the window count.
                for target in selected.reversed() {
                    try Task.checkCancellation()
                    guard let source = shareable.windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid }),
                          source.frame == target.frame else {
                        throw ComputerFailure("stale_snapshot", "A target window changed during capture; observe again.")
                    }
                    let layer = try await capture(SCContentFilter(desktopIndependentWindow: source),
                        width: max(1, Int(target.frame.width * scale)), height: max(1, Int(target.frame.height * scale)))
                    canvas.draw(layer, bounds: target.frame)
                }
                image = try canvas.image()
            }
        }
        try Task.checkCancellation()
        // Share the existing one-second AX observation budget across root
        // resolution and traversal, rather than multiplying it per window.
        let axDeadline = Date().addingTimeInterval(1)
        var roots: [(WindowIdentity, AXUIElement)] = []
        var applicationRoots: [(WindowIdentity, AXUIElement)] = []
        var rootsTruncated = false
        if request.mode != .vision && AXIsProcessTrusted() {
            if let subtree {
                guard selected.contains(subtree.window) else { throw ComputerFailure("invalid_arguments", "The subtree must belong to the observation target.") }
                if subtree.applicationUI { applicationRoots = [(subtree.window, subtree.value)] }
                else { roots = [(subtree.window, subtree.value)] }
            } else {
                for window in selected {
                    if Date() >= axDeadline { rootsTruncated = true; break }
                    if let root = windowElement(window, deadline: axDeadline) { roots.append((window, root)) }
                    else { rootsTruncated = true }
                }
            }
        }
        if request.scope == .app, request.mode != .vision, subtree == nil, AXIsProcessTrusted(), let anchor = selected.first(where: { $0.layer == 0 }) ?? selected.first {
            let app = AXUIElementCreateApplication(anchor.pid)
            for name in [kAXMenuBarAttribute, kAXExtrasMenuBarAttribute] {
                if let root = attribute(app, name), CFGetTypeID(root) == AXUIElementGetTypeID() { applicationRoots.append((anchor, root as! AXUIElement)) }
            }
        }
        let tree = accessibilityTree(roots, applicationRoots: applicationRoots, deadline: axDeadline)
        var next = Snapshot(scope: request.scope, frame: frame, windows: selected, display: display,
            imageWidth: image?.width, imageHeight: image?.height, elements: tree.elements,
            rows: tree.rows, truncated: tree.truncated || rootsTruncated, mode: request.mode, revisions: revisions)
        var recognitionTruncated = false
        if recognize, let image {
            let recognized = try await recognizeText(image)
            next.textRegions = recognized.regions
            recognitionTruncated = recognized.truncated
        }
        try Task.checkCancellation()
        try next.validate(id: next.id, windows: windows(), displays: displays())
        var png: Data?
        if let image {
            guard let encoded = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                throw ComputerFailure("capture_failed", "macOS did not encode the screenshot.")
            }
            png = encoded
        }
        var data: [String: Any] = ["snapshot_id": next.id, "scope": request.scope.rawValue, "mode": request.mode.rawValue,
            "frame": frameData(frame), "windows": selected.map { ["pid": $0.pid, "window_id": $0.windowID, "frame": frameData($0.frame)] as [String: Any] },
            "elements": tree.rows, "tree_truncated": tree.truncated || rootsTruncated, "accessibility": AXIsProcessTrusted()]
        if let pid = request.pid { data["pid"] = pid }
        if let windowID = request.windowID { data["window_id"] = windowID }
        if let display { data["display_id"] = display.id }
        if let image { data["image_width"] = image.width; data["image_height"] = image.height }
        if recognize { data["text_regions"] = next.textRegions.map(\.data); data["text_regions_truncated"] = recognitionTruncated }
        if args["disable_diff"] as? Bool != true, let previous,
           request.mode != .vision, previous.mode != .vision, AXIsProcessTrusted(),
           previous.scope == next.scope, previous.windows.map(\.windowID) == next.windows.map(\.windowID),
           previous.display == next.display {
            data["diff"] = next.difference(from: previous)
        }
        snapshot = next
        lastObservation = next
        return try result(data, image: png)
    }

    func capture(_ filter: SCContentFilter, width: Int, height: Int) async throws -> CGImage {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        return try await nativeRequest { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                if let error { done(.failure(error)) }
                else if let image { done(.success(image)) }
                else { done(.failure(ComputerFailure("capture_failed", "macOS returned no screenshot."))) }
            }
        }
    }
}
