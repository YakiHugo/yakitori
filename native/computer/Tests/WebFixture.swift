import AppKit
import WebKit

final class WebFixtureApplication: NSApplication {
    var received: ((NSEvent) -> Void)?
    override func sendEvent(_ event: NSEvent) { received?(event); super.sendEvent(event) }
}

final class WebFixture: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let output: URL
    let window: NSWindow
    var lastState: [String: Any] = [:]
    var nativeEvents: [[String: Any]] = []
    init(output: URL, page: URL, second: Bool = false) {
        self.output = output
        window = NSWindow(contentRect: NSRect(x: 140, y: 140, width: 640, height: 520), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "fixture")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        window.title = second ? "Yakitori WebKit Fixture 2" : "Yakitori WebKit Fixture"
        if second { window.setFrameOrigin(NSPoint(x: 660, y: 140)) }
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("emit()") { _, error in
            if let error { fatalError("Fixture script failed: \(error)") }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fatalError("Fixture navigation failed: \(error)") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fatalError("Fixture navigation failed: \(error)") }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        do {
            guard let text = message.body as? String,
                  let state = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { fatalError("Invalid fixture state") }
            lastState = state; save()
        } catch { fatalError("Fixture output failed: \(error)") }
    }
    func record(_ event: NSEvent) {
        guard event.windowNumber == window.windowNumber,
              [.leftMouseDown, .leftMouseUp, .leftMouseDragged].contains(event.type) else { return }
        let view = window.contentView
        let hit = view.flatMap { $0.hitTest($0.convert(event.locationInWindow, from: nil)) }
        nativeEvents.append(["type": event.type.rawValue, "window": event.windowNumber, "resolved_window": event.window?.windowNumber ?? 0,
            "hit": hit.map { String(describing: type(of: $0)) } ?? "", "x": event.locationInWindow.x, "y": event.locationInWindow.y, "clicks": event.clickCount])
        nativeEvents = Array(nativeEvents.suffix(24)); save()
    }
    func save() {
        guard !lastState.isEmpty else { return }
        var state = lastState
        state["pid"] = getpid(); state["window_id"] = window.windowNumber; state["native_events"] = nativeEvents
        state["key_window"] = NSApp.keyWindow?.windowNumber ?? 0; state["active"] = NSApp.isActive
        state["app_windows"] = (NSApp.accessibilityWindows() ?? []).compactMap { ($0 as? NSWindow)?.windowNumber }
        state["native_frame"] = ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]
        do { try JSONSerialization.data(withJSONObject: state).write(to: output, options: .atomic) }
        catch { fatalError("Fixture output failed: \(error)") }
    }
}

let app = WebFixtureApplication.shared as! WebFixtureApplication
let menu = NSMenu()
let applicationMenu = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
applicationMenu.submenu = NSMenu(title: "Fixture")
menu.addItem(applicationMenu)
let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
edit.submenu = NSMenu(title: "Edit")
edit.submenu!.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
edit.submenu!.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
menu.addItem(edit)
app.mainMenu = menu
if CommandLine.arguments[2] == "--focus-holder" {
    app.setActivationPolicy(.regular)
    let window = NSWindow(contentRect: NSRect(x: 820, y: 160, width: 300, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Yakitori Background Input Test"
    let observer = NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification, object: app, queue: .main) { _ in
        window.makeKeyAndOrderFront(nil)
        do { try Data(String(getpid()).utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic) }
        catch { fatalError("Focus fixture readiness failed: \(error)") }
    }
    withExtendedLifetime((window, observer)) { app.run() }
} else {
    app.setActivationPolicy(.regular)
    let page = URL(fileURLWithPath: CommandLine.arguments[2])
    var fixtures = [WebFixture(output: URL(fileURLWithPath: CommandLine.arguments[1]), page: page)]
    if CommandLine.arguments.count > 3 {
        fixtures.append(WebFixture(output: URL(fileURLWithPath: CommandLine.arguments[3]), page: page, second: true))
    }
    app.received = { event in fixtures.forEach { $0.record(event) } }
    withExtendedLifetime(fixtures) { app.run() }
}
