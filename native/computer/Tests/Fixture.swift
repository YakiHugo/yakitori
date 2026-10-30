import AppKit
import Darwin

private typealias CopySpaces = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
private typealias MainConnection = @convention(c) () -> Int32
private let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
func fixtureSpaces(_ id: Int) -> [NSNumber] {
    guard let skyLight, let copy = dlsym(skyLight, "SLSCopySpacesForWindows"), let connection = dlsym(skyLight, "SLSMainConnectionID") else { return [] }
    let read = unsafeBitCast(copy, to: CopySpaces.self)
    return read(unsafeBitCast(connection, to: MainConnection.self)(), 7, [NSNumber(value: id)] as CFArray)?.takeRetainedValue() as? [NSNumber] ?? []
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

final class HoverTarget: NSView {
    var allowsAlternate = true
    var alternate = false
    var transitions = 0
    var moves = 0
    var changed: (() -> Void)?
    override func accessibilityPerformShowAlternateUI() -> Bool {
        if !alternate { alternate = true; transitions += 1; changed?() }
        return true
    }
    override func accessibilityPerformShowDefaultUI() -> Bool {
        if alternate { alternate = false; transitions += 1; changed?() }
        return true
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(accessibilityPerformShowAlternateUI) || selector == #selector(accessibilityPerformShowDefaultUI) { return allowsAlternate }
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseMoved(with event: NSEvent) { moves += 1; changed?() }
    override func draw(_ dirtyRect: NSRect) {
        (alternate ? NSColor.systemGreen : NSColor.systemOrange).setFill()
        bounds.fill()
    }
}

final class Fixture: NSObject, NSTextFieldDelegate, NSMenuDelegate {
    let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let first = NSTextField(frame: NSRect(x: 30, y: 230, width: 420, height: 28))
    let second = NSTextField(frame: NSRect(x: 30, y: 185, width: 420, height: 28))
    let label = NSTextField(labelWithString: "0")
    let canvas = DragTarget(frame: NSRect(x: 250, y: 30, width: 200, height: 100))
    let output: URL
    let rich = NSTextView(frame: NSRect(x: 20, y: 15, width: 180, height: 35))
    var changes = 0
    var pointerDown = 0
    var pointerUp = 0
    var count = 0
    var moves = 0
    var secondary: NSWindow?
    var interaction: NSWindow?
    let hover = HoverTarget(frame: NSRect(x: 20, y: 60, width: 180, height: 160))
    let pointerHover = HoverTarget(frame: NSRect(x: 230, y: 140, width: 160, height: 100))
    var menuCount = 0
    var menusOpen = 0
    var events: [[String: Any]] = []

    func record(_ event: NSEvent) {
        guard [.leftMouseDown, .leftMouseUp, .mouseMoved, .keyDown, .flagsChanged, .appKitDefined].contains(event.type) else { return }
        if event.type == .leftMouseDown { pointerDown += 1 }
        if event.type == .leftMouseUp { pointerUp += 1 }
        events.append(["type": event.type.rawValue, "window": event.windowNumber, "x": event.locationInWindow.x,
            "y": event.locationInWindow.y, "flags": event.modifierFlags.rawValue])
        events = Array(events.suffix(12))
        save()
    }

    init(output: URL) {
        self.output = output
        super.init()
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
            let extra = NSWindow(contentRect: NSRect(x: 700, y: 180, width: 220, height: 160), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            extra.title = "Yakitori Secondary Fixture"
            extra.isReleasedWhenClosed = false
            let control = NSButton(title: "Secondary increment", target: self, action: #selector(increment))
            control.frame = NSRect(x: 20, y: 60, width: 180, height: 36)
            extra.contentView!.addSubview(control)
            rich.isRichText = true
            rich.setAccessibilityLabel("Rich input")
            extra.contentView!.addSubview(rich)
            let later = NSButton(title: "Change later", target: self, action: #selector(changeLater))
            later.frame = NSRect(x: 20, y: 110, width: 180, height: 30)
            extra.contentView!.addSubview(later)
            extra.orderBack(nil)
            secondary = extra
        }
        if CommandLine.arguments.contains("--interaction-fixture") {
            let extra = NSWindow(contentRect: NSRect(x: 950, y: 120, width: 420, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            extra.title = "Yakitori Interaction Fixture"
            extra.isReleasedWhenClosed = false
            extra.acceptsMouseMovedEvents = true
            hover.setAccessibilityElement(true)
            hover.setAccessibilityRole(.group)
            hover.setAccessibilityLabel("Alternate hover")
            hover.changed = { [weak self] in self?.hover.needsDisplay = true; self?.save() }
            let child = NSButton(title: "Hover child", target: self, action: #selector(increment))
            child.frame = NSRect(x: 20, y: 20, width: 140, height: 28)
            hover.addSubview(child)
            extra.contentView!.addSubview(hover)
            pointerHover.allowsAlternate = false
            pointerHover.setAccessibilityElement(true)
            pointerHover.setAccessibilityRole(.group)
            pointerHover.setAccessibilityLabel("Pointer hover")
            pointerHover.changed = { [weak self] in self?.save() }
            extra.contentView!.addSubview(pointerHover)
            let exit = NSButton(title: "Hover exit", target: self, action: #selector(increment))
            exit.frame = NSRect(x: 230, y: 80, width: 140, height: 28)
            extra.contentView!.addSubview(exit)
            interaction = extra
            extra.orderBack(nil)
        }
        save()
    }

    @objc func menuIncrement() { menuCount += 1; save() }
    func menuWillOpen(_ menu: NSMenu) { menusOpen += 1; save() }
    func menuDidClose(_ menu: NSMenu) { menusOpen = max(0, menusOpen - 1); save() }
    @objc func increment() { count += 1; label.stringValue = String(count); save() }
    @objc func changeLater() {
        changes += 1
        let value = "Later-\(changes)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.rich.string = value; self.save() }
        save()
    }
    func controlTextDidChange(_ notification: Notification) { save() }
    func move() {
        moves += 1
        window.setFrameOrigin(NSPoint(x: window.frame.minX + 30, y: window.frame.minY + 20))
        save()
    }
    func closeWindow() { window.close(); save() }
    func save() {
        do {
            let windowServer: [[String: Any]] = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
                .filter { $0[kCGWindowOwnerPID as String] as? Int32 == getpid() }.map { row in
                    ["id": row[kCGWindowNumber as String] ?? 0, "frame": row[kCGWindowBounds as String] ?? [:], "onscreen": row[kCGWindowIsOnscreen as String] ?? false]
                }
            let bytes = try JSONSerialization.data(withJSONObject: [
                "pid": getpid(), "count": count, "first": first.stringValue, "second": second.stringValue,
                "moves": moves, "visible": window.isVisible, "height": window.frame.height,
                "dragging": canvas.dragging, "mouse_down": canvas.downCount, "mouse_up": canvas.upCount,
                "window_id": window.windowNumber, "secondary_window_id": secondary?.windowNumber ?? 0,
                "events": events, "active": NSApp.isActive, "key_window": NSApp.keyWindow?.windowNumber ?? 0,
                "ax_window_ids": (NSApp.accessibilityWindows() ?? []).compactMap { ($0 as? NSWindow)?.windowNumber },
                "window_server": windowServer,
                "window_spaces": NSApp.windows.map { ["id": $0.windowNumber, "visible": $0.isVisible, "active_space": $0.isOnActiveSpace, "spaces": fixtureSpaces($0.windowNumber)] as [String: Any] },
                "interaction_window_id": interaction?.windowNumber ?? 0, "hover_alternate": hover.alternate,
                "hover_moves": pointerHover.moves, "hover_transitions": hover.transitions, "menu_count": menuCount, "menus_open": menusOpen,
                "rich": rich.string, "changes": changes, "hidden": NSApp.isHidden,
                "rich_selection": ["location": rich.selectedRange().location, "length": rich.selectedRange().length],
                "pointer_down": pointerDown, "pointer_up": pointerUp,
                "secondary_minimized": secondary?.isMiniaturized ?? false,
                "secondary_frame": secondary.map { ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height] } ?? [:],
                "rich_bold": rich.textStorage.flatMap { $0.length > 0 ? $0.attribute(.font, at: 0, effectiveRange: nil) as? NSFont : nil }
                    .map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } ?? false,
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
editMenu.submenu!.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
menu.addItem(editMenu)
app.mainMenu = menu
let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
    : Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("fixture-state.json").path
let fixture = Fixture(output: URL(fileURLWithPath: statePath))
let delayedMenuItem = editMenu.submenu!.addItem(withTitle: "Delayed menu update", action: #selector(Fixture.changeLater), keyEquivalent: "")
delayedMenuItem.target = fixture
if CommandLine.arguments.contains("--interaction-fixture") {
    let top = NSMenuItem(title: "Automation", action: nil, keyEquivalent: "")
    let automation = NSMenu(title: "Automation")
    automation.autoenablesItems = false
    automation.delegate = fixture
    top.submenu = automation
    menu.addItem(top)
    let nested = NSMenuItem(title: "Actions", action: nil, keyEquivalent: "")
    let actions = NSMenu(title: "Actions")
    actions.autoenablesItems = false
    actions.delegate = fixture
    nested.submenu = actions
    automation.addItem(nested)
    let increment = actions.addItem(withTitle: "Increment", action: #selector(Fixture.menuIncrement), keyEquivalent: "")
    increment.target = fixture
    for _ in 0..<2 { automation.addItem(withTitle: "Ambiguous", action: #selector(Fixture.menuIncrement), keyEquivalent: "").target = fixture }
    let disabled = automation.addItem(withTitle: "Disabled", action: #selector(Fixture.menuIncrement), keyEquivalent: "")
    disabled.target = fixture
    disabled.isEnabled = false
}
app.received = { fixture.record($0) }
let activityObservers = [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification].map { name in
    NotificationCenter.default.addObserver(forName: name, object: app, queue: .main) { _ in fixture.save() }
}
let stateTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in fixture.save() }
let signals = [(SIGUSR1, { fixture.move() }), (SIGUSR2, { fixture.closeWindow() }), (SIGHUP, { fixture.changeLater() }),
    (SIGWINCH, { app.setActivationPolicy(.regular); fixture.save() })].map { code, action -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler(handler: action)
    source.resume()
    return source
}
app.run()
