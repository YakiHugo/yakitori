// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "YakitoriComputer",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "yakitori-computer", targets: ["ComputerServer"])],
    targets: [
        .target(name: "ComputerCore"),
        .executableTarget(name: "ComputerServer", dependencies: ["ComputerCore"]),
    ]
)
