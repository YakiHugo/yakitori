import Foundation
import Darwin

func proxyThroughApplication() throws {
    guard Bundle.main.bundleURL.pathExtension == "app" else {
        throw NSError(domain: "YakitoriComputer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Run the built Yakitori Computer.app executable with --mcp."])
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("yakitori-computer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { removePipeDirectory(directory) }
    let input = directory.appendingPathComponent("input").path
    let output = directory.appendingPathComponent("output").path
    guard mkfifo(input, 0o600) == 0, mkfifo(output, 0o600) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let inputFD = open(input, O_RDWR | O_CLOEXEC)
    let outputFD = open(output, O_RDWR | O_CLOEXEC)
    guard inputFD >= 0, outputFD >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    let inputHandle = FileHandle(fileDescriptor: inputFD, closeOnDealloc: true)
    let outputHandle = FileHandle(fileDescriptor: outputFD, closeOnDealloc: true)
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    // LaunchServices attributes TCC grants to our signed helper app instead of
    // whichever Node, Terminal, or IDE happens to host the agent today.
    launcher.arguments = ["-g", "-n", "-W", "-a", Bundle.main.bundleURL.path, "--stdin", input, "--stdout", output, "--stderr", "/dev/stderr", "--args", "--parent", String(getpid())]
    launcher.terminationHandler = { process in
        removePipeDirectory(directory)
        exit(process.terminationStatus)
    }
    try launcher.run()
    DispatchQueue.global().async {
        var opened = false
        while true {
            let data = outputHandle.availableData
            if data.isEmpty { break }
            if !opened {
                // The first reply proves that the app opened both FIFOs.
                // Unlink now: open descriptors keep working, and a later
                // force-kill cannot leave this connection's pipes on disk.
                opened = true
                removePipeDirectory(directory)
            }
            FileHandle.standardOutput.write(data)
        }
    }
    while let line = readLine() { inputHandle.write(Data((line + "\n").utf8)) }
    // Closing the FIFO tells the app to cancel, release held input, and exit.
    try inputHandle.close()
    launcher.waitUntilExit()
}

private func removePipeDirectory(_ directory: URL) {
    do { try FileManager.default.removeItem(at: directory) }
    catch let error as CocoaError where error.code == .fileNoSuchFile {}
    catch { FileHandle.standardError.write(Data("Could not remove computer pipes: \(error)\n".utf8)) }
}
