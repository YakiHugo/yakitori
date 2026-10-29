import AppKit
import Darwin

final class FixtureLabel: NSTextField {
    var onRead: (() -> Void)?
    override func accessibilityValue() -> String? {
        onRead?()
        return super.accessibilityValue()
    }
}

final class FixtureApplication: NSApplication {
    var received: ((NSEvent) -> Void)?
    override func sendEvent(_ event: NSEvent) {
        received?(event)
        super.sendEvent(event)
    }
}

final class DragTarget: NSView {
    var dragging = false
    var downCount = 0
    var upCount = 0
    var changed: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.setFill()
        bounds.fill()
    }
    override func mouseDown(with event: NSEvent) {
        dragging = true
        downCount += 1
        changed?()
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        upCount += 1
        changed?()
    }
}

final class Fixture: NSObject, NSTextFieldDelegate {
    let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let first = NSTextField(frame: NSRect(x: 30, y: 230, width: 420, height: 28))
    let second = NSTextField(frame: NSRect(x: 30, y: 185, width: 420, height: 28))
    let label = FixtureLabel(labelWithString: "0")
    let canvas = DragTarget(frame: NSRect(x: 250, y: 30, width: 200, height: 100))
    let output: URL
    var count = 0
    var moves = 0
    var secondary: NSWindow?
    var events: [[String: Any]] = []
    var scheduledChanges = 0
    var completedChanges = 0
    var axReads = 0

    func record(_ event: NSEvent) {
        guard [.leftMouseDown, .leftMouseUp, .keyDown, .flagsChanged, .appKitDefined].contains(event.type) else { return }
        events.append(["type": event.type.rawValue, "window": event.windowNumber, "x": event.locationInWindow.x,
            "y": event.locationInWindow.y, "flags": event.modifierFlags.rawValue])
        events = Array(events.suffix(12))
        save()
    }

    init(output: URL) {
        self.output = output
        super.init()
        label.onRead = { [weak self] in
            if let self { self.axReads += 1; self.save() }
        }
        window.title = "Yakitori Computer Fixture"
        window.isReleasedWhenClosed = false
        first.setAccessibilityLabel("First input")
        second.setAccessibilityLabel("Second input")
        for field in [first, second] {
            field.delegate = self
            window.contentView!.addSubview(field)
        }
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.frame = NSRect(x: 30, y: 100, width: 140, height: 36)
        window.contentView!.addSubview(button)
        label.frame = NSRect(x: 30, y: 55, width: 140, height: 30)
        window.contentView!.addSubview(label)
        canvas.changed = { [weak self] in self?.save() }
        window.contentView!.addSubview(canvas)
        window.orderBack(nil)
        if CommandLine.arguments.contains("--multi-window") {
            let extra = NSWindow(contentRect: NSRect(x: 700, y: 180, width: 220, height: 160), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            extra.title = "Yakitori Secondary Fixture"
            extra.isReleasedWhenClosed = false
            let control = NSButton(title: "Secondary increment", target: self, action: #selector(increment))
            control.frame = NSRect(x: 20, y: 60, width: 180, height: 36)
            extra.contentView!.addSubview(control)
            extra.orderBack(nil)
            secondary = extra
        }
        save()
    }

    @objc func increment() { count += 1; label.stringValue = String(count); save() }
    func controlTextDidChange(_ notification: Notification) { save() }
    func move() {
        moves += 1
        window.setFrameOrigin(NSPoint(x: window.frame.minX + 30, y: window.frame.minY + 20))
        save()
    }
    func closeWindow() { window.close(); save() }
    func scheduleChange() {
        scheduledChanges += 1
        let text = "Wait ready \(scheduledChanges)"
        save()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.label.stringValue = text
            self.completedChanges += 1
            self.save()
        }
    }
    func save() {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: [
                "pid": getpid(), "count": count, "first": first.stringValue, "second": second.stringValue,
                "moves": moves, "visible": window.isVisible, "height": window.frame.height,
                "dragging": canvas.dragging, "mouse_down": canvas.downCount, "mouse_up": canvas.upCount,
                "window_id": window.windowNumber, "secondary_window_id": secondary?.windowNumber ?? 0,
                "events": events, "active": NSApp.isActive, "key_window": NSApp.keyWindow?.windowNumber ?? 0,
                "foreground_pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                "selection_location": second.currentEditor()?.selectedRange.location ?? -1,
                "selection_length": second.currentEditor()?.selectedRange.length ?? -1,
                "scheduled_changes": scheduledChanges, "completed_changes": completedChanges,
                "ax_reads": axReads,
            ])
            try bytes.write(to: output, options: .atomic)
        } catch { fatalError("Fixture persistence failed: \(error)") }
    }
}

let app = FixtureApplication.shared as! FixtureApplication
app.setActivationPolicy(.accessory)
// Exercise the standard responder-chain shortcut used by real AppKit apps.
// A bare NSApplication has no Edit menu, so CMD+A otherwise has no action.
let menu = NSMenu()
let applicationMenu = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
applicationMenu.submenu = NSMenu(title: "Fixture")
menu.addItem(applicationMenu)
let editMenu = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
editMenu.submenu = NSMenu(title: "Edit")
editMenu.submenu!.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
menu.addItem(editMenu)
app.mainMenu = menu
let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
    : Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("fixture-state.json").path
let fixture = Fixture(output: URL(fileURLWithPath: statePath))
app.received = { fixture.record($0) }
// AX value writes need not emit a text-edit delegate notification. Persist the
// actual AppKit state independently of which input route changed the control.
let stateTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in fixture.save() }
let activityObservers = [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification].map { name in
    NotificationCenter.default.addObserver(forName: name, object: app, queue: .main) { _ in fixture.save() }
}
let signals = [(SIGUSR1, { fixture.move() }), (SIGUSR2, { fixture.closeWindow() }), (SIGWINCH, { fixture.scheduleChange() })].map { code, action -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler(handler: action)
    source.resume()
    return source
}
app.run()
