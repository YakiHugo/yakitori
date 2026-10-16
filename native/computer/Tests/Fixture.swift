import AppKit
import Darwin

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
    let label = NSTextField(labelWithString: "0")
    let canvas = DragTarget(frame: NSRect(x: 250, y: 30, width: 200, height: 100))
    let output: URL
    var count = 0
    var moves = 0

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
    func save() {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: [
                "pid": getpid(), "count": count, "first": first.stringValue, "second": second.stringValue,
                "moves": moves, "visible": window.isVisible, "height": window.frame.height,
                "dragging": canvas.dragging, "mouse_down": canvas.downCount, "mouse_up": canvas.upCount,
            ])
            try bytes.write(to: output, options: .atomic)
        } catch { fatalError("Fixture persistence failed: \(error)") }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let fixture = Fixture(output: URL(fileURLWithPath: CommandLine.arguments[1]))
let signals = [(SIGUSR1, { fixture.move() }), (SIGUSR2, { fixture.closeWindow() })].map { code, action -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler(handler: action)
    source.resume()
    return source
}
app.run()
