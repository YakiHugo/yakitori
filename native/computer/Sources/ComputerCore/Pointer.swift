import AppKit
import CoreGraphics

// postToPid bypasses WindowServer hit testing. The Quartz hit-test fields do
// not set NSEvent.windowNumber, so encode the AppKit window identity as well.
func windowPointerEvent(_ event: CGEvent, window: WindowIdentity) throws -> CGEvent {
    let pointerTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged,
                                     .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                                     .otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel]
    guard pointerTypes.contains(event.type),
          let type = NSEvent.EventType(rawValue: UInt(event.type.rawValue)) else {
        throw ComputerFailure("input_failed", "Expected a pointer event for window routing.")
    }
    let point = event.location
    let local = CGPoint(x: point.x - window.frame.minX, y: window.frame.maxY - point.y)
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
