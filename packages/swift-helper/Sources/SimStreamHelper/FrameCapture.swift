import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC

/// Headless simulator frame capture at 60fps via direct IOSurface access.
///
/// Uses the CoreSimulator IO port descriptor's `framebufferSurface` property
/// which returns a shared IOSurface representing the simulator's display.
/// CVPixelBuffer is created zero-copy from the IOSurface for H.264 encoding.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → H.264 encode
final class FrameCapture {
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var pollTimer: DispatchSourceTimer?
    private let captureQueue = DispatchQueue(label: "frame-capture", qos: .userInteractive)

    // Keep references alive
    private var descriptor: NSObject?
    private var ioClient: NSObject?

    func start(deviceUDID: String, onFrame: @escaping (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)

        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }

        // Get the IO client and update ports
        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw makeError(3, "Failed to get device IO")
        }
        io.perform(NSSelectorFromString("updateIOPorts"))
        self.ioClient = io

        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw makeError(4, "Failed to get IO ports")
        }

        // Find the main LCD display port descriptor
        // The LAST framebuffer.display port is the main LCD (displayClass=0)
        var mainDescriptor: NSObject?
        let pidSel = NSSelectorFromString("portIdentifier")
        let descSel = NSSelectorFromString("descriptor")
        for port in ports {
            guard port.responds(to: pidSel),
                  let pid = port.perform(pidSel)?.takeUnretainedValue(),
                  "\(pid)" == "com.apple.framebuffer.display",
                  port.responds(to: descSel),
                  let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject else { continue }
            mainDescriptor = desc
        }

        guard let desc = mainDescriptor else {
            throw makeError(5, "No framebuffer display descriptor found")
        }
        self.descriptor = desc

        // Verify framebufferSurface is available
        let surfSel = NSSelectorFromString("framebufferSurface")
        guard desc.responds(to: surfSel) else {
            throw makeError(6, "Descriptor doesn't have framebufferSurface")
        }

        // Get initial surface to verify and get dimensions
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else {
            throw makeError(7, "framebufferSurface returned nil (is the device booted?)")
        }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)
        capturedWidth = IOSurfaceGetWidth(surface)
        capturedHeight = IOSurfaceGetHeight(surface)
        print("[capture] Framebuffer: \(capturedWidth)x\(capturedHeight) (direct IOSurface, zero-copy)")

        // Start 120fps polling timer
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(8)) // ~120fps
        timer.setEventHandler { [weak self] in
            self?.pollFrame()
        }
        timer.resume()
        self.pollTimer = timer

        print("[capture] 120fps IOSurface capture started")
    }

    private func pollFrame() {
        guard let desc = descriptor else { return }

        let surfSel = NSSelectorFromString("framebufferSurface")
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { return }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return }

        if capturedWidth != w || capturedHeight != h {
            capturedWidth = w
            capturedHeight = h
            print("[capture] Surface size changed: \(w)x\(h)")
        }

        // Zero-copy CVPixelBuffer from IOSurface
        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return }

        frameCount += 1
        let timestamp = CMTime(value: CMTimeValue(frameCount), timescale: 120)
        onFrame?(pb, timestamp)
    }

    func getScreenSize() -> (width: Int, height: Int)? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return (capturedWidth, capturedHeight)
    }

    func stop() {
        pollTimer?.cancel()
        pollTimer = nil
        descriptor = nil
        ioClient = nil
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    // MARK: - Device lookup (used by HIDInjector too)

    static func findSimDevice(udid: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let developerDir = getDeveloperDir()
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let context = contextClass.perform(sharedSel, with: developerDir, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        let deviceSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let deviceSet = context.perform(deviceSetSel, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        guard let devices = deviceSet.value(forKey: "devices") as? [NSObject] else { return nil }
        return devices.first(where: {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        })
    }

    static func getDeveloperDir() -> String {
        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = pipe
        try? process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/Applications/Xcode.app/Contents/Developer"
    }
}
