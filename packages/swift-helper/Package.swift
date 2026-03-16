// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimStreamHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "sim-stream-helper",
            path: "Sources/SimStreamHelper",
            swiftSettings: [
                .unsafeFlags([
                    "-F/Library/Developer/PrivateFrameworks",
                    "-F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F/Library/Developer/PrivateFrameworks",
                    "-F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                ]),
                .linkedFramework("CoreSimulator"),
                .linkedFramework("SimulatorKit"), // Needed for HIDInjector
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOSurface"),
            ]
        ),
    ]
)
