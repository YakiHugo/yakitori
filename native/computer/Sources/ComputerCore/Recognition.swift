import Foundation
// Vision's Objective-C request predates Sendable. Configure before dispatch;
// only cancel() crosses threads while perform/results stay on the worker.
@preconcurrency import Vision

struct TextRegion {
    let id = "region_" + UUID().uuidString
    let text: String
    let confidence: Float
    let frame: CGRect

    var data: [String: Any] {
        ["region_id": id, "text": text, "confidence": confidence, "frame": frameData(frame)]
    }
}

func recognitionEnabled(_ args: [String: Any], mode: ObservationMode) throws -> Bool {
    guard let value = args["recognize_text"] else { return false }
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID(), mode != .ax else {
        throw ComputerFailure("invalid_arguments", "recognize_text must be a boolean on a vision/both observation or zoom.")
    }
    return number.boolValue
}

func textRegionFrame(_ normalized: CGRect, width: Int, height: Int) -> CGRect {
    // Vision uses a bottom-left origin; screenshot inputs use top-left pixels.
    CGRect(x: normalized.minX * Double(width), y: (1 - normalized.maxY) * Double(height),
        width: normalized.width * Double(width), height: normalized.height * Double(height))
}

func recognizeText(_ image: CGImage) async throws -> (regions: [TextRegion], truncated: Bool) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.automaticallyDetectsLanguage = true
    // Cancel Vision on timeout/turn cancellation as well as draining the caller.
    defer { request.cancel() }
    return try await nativeRequest { done in
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
                var regions: [TextRegion] = []
                var bytes = 0
                var truncated = false
                // Bound optional OCR text to 64 KiB and 256 regions alongside
                // the AX tree and PNG within the existing MCP frame boundary.
                for observation in request.results ?? [] {
                    guard let candidate = observation.topCandidates(1).first else { continue }
                    guard regions.count < 256, bytes + candidate.string.utf8.count <= 64 * 1024 else {
                        truncated = true; break
                    }
                    bytes += candidate.string.utf8.count
                    regions.append(TextRegion(text: candidate.string, confidence: candidate.confidence,
                        frame: textRegionFrame(observation.boundingBox, width: image.width, height: image.height)))
                }
                done(.success((regions, truncated)))
            } catch { done(.failure(error)) }
        }
    }
}
