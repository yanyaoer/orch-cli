// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OrchApp",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "OrchApp", path: "Sources/OrchApp")
    ]
)
