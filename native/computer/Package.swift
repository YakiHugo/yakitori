// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "YakitoriComputer",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "yakitori-computer", targets: ["ComputerServer"])],
    targets: [
        .target(name: "DisplayBridge", publicHeadersPath: "include", cSettings: [.unsafeFlags(["-fobjc-arc"])], linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("CoreGraphics")]),
        .target(name: "ComputerCore", dependencies: ["DisplayBridge"]),
        .executableTarget(name: "ComputerServer", dependencies: ["ComputerCore"]),
    ]
)
