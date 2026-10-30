import AppKit
import CoreGraphics
import Darwin

private typealias SetWindowLocation = @convention(c) (CGEvent, Double, Double) -> Void
private let windowLocation = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation")
    .map { unsafeBitCast($0, to: SetWindowLocation.self) }

// postToPid bypasses WindowServer hit testing. The Quartz hit-test fields do
// not set NSEvent.windowNumber, so encode the AppKit window identity as well.
func windowPointerEvent(_ event: CGEvent, window: WindowIdentity, windowFrame: CGRect? = nil) throws -> CGEvent {
    // PID-directed AppKit transport reads a separate window-local point; the
    // public global location does not populate it. This macOS SPI is optional:
    // fail before sending a button down when unavailable, never auto-escalate.
    guard let windowLocation else {
        throw ComputerFailure("foreground_required", "This macOS version cannot route background pointer coordinates; observe again and choose foreground delivery explicitly.")
    }
    let pointerTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged,
                                     .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                                     .otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel]
    guard pointerTypes.contains(event.type),
          let type = NSEvent.EventType(rawValue: UInt(event.type.rawValue)) else {
        throw ComputerFailure("input_failed", "Expected a pointer event for window routing.")
    }
    let point = event.location
    // WindowServer can include an outer border absent from NSWindow's event
    // coordinates. Use the exact AX window frame when it is available.
    let frame = windowFrame ?? window.frame
    let local = CGPoint(x: point.x - frame.minX, y: frame.maxY - point.y)
    // AppKit's mouse factory supplies a window identity for the CGEvent bridge;
    // wheel payloads are then restored without changing their pixel units.
    guard let native = NSEvent.mouseEvent(with: type == .scrollWheel ? .mouseMoved : type,
        location: local, modifierFlags: [], timestamp: Double(event.timestamp) / 1_000_000_000,
        windowNumber: Int(window.windowID), context: nil,
        eventNumber: Int(event.getIntegerValueField(.mouseEventNumber)),
        clickCount: Int(event.getIntegerValueField(.mouseEventClickState)),
        pressure: Float(event.getDoubleValueField(.mouseEventPressure))),
          let routed = native.cgEvent else {
        throw ComputerFailure("input_failed", "macOS could not encode the target window for pointer input.")
    }
    routed.type = event.type
    routed.location = point
    windowLocation(routed, point.x - frame.minX, point.y - frame.minY)
    routed.flags = event.flags
    routed.setIntegerValueField(.mouseEventButtonNumber, value: event.getIntegerValueField(.mouseEventButtonNumber))
    if type == .scrollWheel {
        for field: CGEventField in [.scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2,
                                   .scrollWheelEventFixedPtDeltaAxis1, .scrollWheelEventFixedPtDeltaAxis2,
                                   .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2,
                                   .scrollWheelEventIsContinuous] {
            routed.setIntegerValueField(field, value: event.getIntegerValueField(field))
        }
    }
    return routed
}
