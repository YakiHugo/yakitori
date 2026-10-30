import AppKit
import ComputerCore
import Darwin

if CommandLine.arguments.contains("--display-service") {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    Task { @MainActor in
        do { try await runDisplayService() }
        catch { FileHandle.standardError.write(Data("Display service failed: \(error)\n".utf8)); exit(1) }
    }
    application.run()
    exit(0)
}

if CommandLine.arguments.contains("--mcp") {
    try proxyThroughApplication()
    exit(0)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let server = MainActor.assumeIsolated { Server() }
let signals = [SIGINT, SIGTERM].map { code -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler { Task { @MainActor in server.shutdown() } }
    source.resume()
    return source
}
if let parentIndex = CommandLine.arguments.firstIndex(of: "--parent"),
   CommandLine.arguments.indices.contains(parentIndex + 1),
   let parent = Int32(CommandLine.arguments[parentIndex + 1]) {
    // LaunchServices owns this process, so its real parent is not the MCP
    // client. Watch the proxy explicitly to prevent orphaned capture services.
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
        if kill(parent, 0) != 0 { Task { @MainActor in server.shutdown() } }
    }
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        DispatchQueue.main.async { server.receive(line) }
    }
    DispatchQueue.main.async { server.shutdown() }
}
application.run()

@MainActor final class Server {
    let computer = Computer()
    var pending: [[String: Any]] = []
    var active: (id: String, task: Task<Void, Never>)?
    var closing = false
    var finishingShutdown = false

    func receive(_ line: String) {
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  request["jsonrpc"] as? String == "2.0", let method = request["method"] as? String else {
                reply(["id": NSNull(), "error": ["code": -32600, "message": "Invalid JSON-RPC request."]])
                return
            }
            if method == "notifications/cancelled" {
                let id = (request["params"] as? [String: Any])?["requestId"]
                if let id, active?.id == requestID(id) { active?.task.cancel() }
                pending.removeAll { requestID($0["id"]) == requestID(id) }
                return
            }
            guard request["id"] != nil, !closing else { return }
            if method != "tools/call" {
                let result: [String: Any]
                switch method {
                case "initialize":
                    result = ["protocolVersion": (request["params"] as? [String: Any])?["protocolVersion"] as? String ?? "2025-11-25", "capabilities": ["tools": [:]], "serverInfo": ["name": "yakitori-computer", "version": "0.1.0"]]
                case "ping": result = [:]
                case "tools/list": result = ["tools": tools]
                default:
                    reply(["id": request["id"]!, "error": ["code": -32601, "message": "Unknown method."]])
                    return
                }
                reply(["id": request["id"]!, "result": result])
                return
            }
            pending.append(request)
            drain()
        } catch {
            reply(["id": NSNull(), "error": ["code": -32700, "message": "Invalid JSON."]])
        }
    }

    func drain() {
        guard active == nil, !pending.isEmpty, !closing else { return }
        let request = pending.removeFirst()
        let id = request["id"]!
        active = (requestID(id), Task { @MainActor in
            defer {
                active = nil
                if closing { finishShutdown() }
                drain()
            }
            do {
                let params = request["params"] as? [String: Any] ?? [:]
                let name = params["name"] as? String
                let result: [String: Any]
                if name == "turn_ended" {
                    try await computer.reset()
                    result = ["content": [["type": "text", "text": "Computer state released."]]]
                } else if name == "control" {
                    result = try await computer.execute(params["arguments"] as? [String: Any] ?? [:])
                } else {
                    throw ComputerFailure("unknown_tool", "Unknown computer tool.")
                }
                reply(["id": id, "result": result])
            } catch {
                let failure = error as? ComputerFailure
                let code = error is CancellationError ? "cancelled" : failure?.code ?? "native_error"
                let message = error is CancellationError ? "Computer operation stopped. An input may have partly completed; observe before continuing." : failure?.message ?? error.localizedDescription
                let evidence = (failure?.evidence ?? [:]).merging(["code": code, "message": message]) { _, value in value }
                reply(["id": id, "result": ["isError": true, "content": [["type": "text", "text": "\(code): \(message)"]], "structuredContent": evidence]])
            }
        })
    }

    func shutdown() {
        closing = true
        pending.removeAll()
        guard let active else { finishShutdown(); return }
        active.task.cancel()
    }

    func finishShutdown() {
        guard !finishingShutdown else { return }
        finishingShutdown = true
        Task { @MainActor in
            do { try await computer.reset(releaseDisplay: true); exit(0) }
            catch { FileHandle.standardError.write(Data("Native cleanup failed; display service retains recovery: \(error)\n".utf8)); exit(1) }
        }
    }

    func reply(_ body: [String: Any]) {
        var response = body
        response["jsonrpc"] = "2.0"
        do {
            var data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
            data.append(10)
            FileHandle.standardOutput.write(data)
        } catch {
            FileHandle.standardError.write(Data("Invalid native response: \(error)\n".utf8))
            exit(1)
        }
    }
}

func requestID(_ value: Any?) -> String {
    if let value = value as? String { return "string:\(value)" }
    if let value = value as? NSNumber { return "number:\(value)" }
    return "null"
}
