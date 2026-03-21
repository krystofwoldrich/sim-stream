import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC

/// Headless simulator frame capture via direct IOSurface access.
///
/// Uses SimulatorKit frame callbacks (via objc_msgSend on the IO port descriptor)
/// for event-driven capture with zero jitter. Maintains a 5fps idle floor
/// for late-joining clients.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → H.264 encode
final class FrameCapture {
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var idleTimer: DispatchSourceTimer?
    private let captureQueue = DispatchQueue(label: "frame-capture", qos: .userInteractive)
    private var lastCaptureTimeMs: UInt64 = 0
    private static let idleIntervalMs: UInt64 = 200

    private var descriptor: NSObject?
    private var ioClient: NSObject?
    private var callbackUUID: NSUUID?

    func start(deviceUDID: String, onFrame: @escaping (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
        _ = dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)

        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }

        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw makeError(3, "Failed to get device IO")
        }
        io.perform(NSSelectorFromString("updateIOPorts"))
        self.ioClient = io

        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw makeError(4, "Failed to get IO ports")
        }

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

        let surfSel = NSSelectorFromString("framebufferSurface")
        guard desc.responds(to: surfSel) else {
            throw makeError(6, "Descriptor doesn't have framebufferSurface")
        }

        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else {
            throw makeError(7, "framebufferSurface returned nil (is the device booted?)")
        }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)
        capturedWidth = IOSurfaceGetWidth(surface)
        capturedHeight = IOSurfaceGetHeight(surface)
        print("[capture] Framebuffer: \(capturedWidth)x\(capturedHeight) (direct IOSurface, zero-copy)")

        try registerFrameCallbacks(desc: desc)
        captureFrame()
        startIdleTimer()
        print("[capture] Frame callbacks registered (event-driven) + 5fps idle floor")
    }

    // MARK: - Frame callbacks via objc_msgSend

    private func registerFrameCallbacks(desc: NSObject) throws {
        let regSel = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")
        guard desc.responds(to: regSel) else {
            throw makeError(8, "Descriptor doesn't support registerScreenCallbacks")
        }

        guard let msgSendPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
            throw makeError(9, "objc_msgSend not found")
        }

        typealias MsgSendFunc = @convention(c) (
            AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject
        ) -> Void
        let msgSend = unsafeBitCast(msgSendPtr, to: MsgSendFunc.self)

        let uuid = NSUUID()
        self.callbackUUID = uuid

        let frameCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrame() }
        }
        let surfacesCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrame() }
        }
        let propsCallback: @convention(block) () -> Void = {}

        msgSend(
            desc, regSel,
            uuid, captureQueue as AnyObject,
            frameCallback as AnyObject, surfacesCallback as AnyObject, propsCallback as AnyObject
        )
    }

    private func startIdleTimer() {
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now().advanced(by: .milliseconds(Int(Self.idleIntervalMs))),
                       repeating: .milliseconds(Int(Self.idleIntervalMs)))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let nowMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
            if (nowMs - self.lastCaptureTimeMs) >= Self.idleIntervalMs {
                self.captureFrame()
            }
        }
        timer.resume()
        self.idleTimer = timer
    }

    // MARK: - Frame capture

    private func captureFrame() {
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

        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return }

        lastCaptureTimeMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
        frameCount += 1
        let timestamp = CMTime(value: CMTimeValue(frameCount), timescale: 60)
        onFrame?(pb, timestamp)
    }

    func getScreenSize() -> (width: Int, height: Int)? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return (capturedWidth, capturedHeight)
    }

    func stop() {
        idleTimer?.cancel()
        idleTimer = nil

        if let uuid = callbackUUID, let desc = descriptor {
            let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
            if desc.responds(to: unregSel) {
                desc.perform(unregSel, with: uuid)
            }
        }
        callbackUUID = nil
        descriptor = nil
        ioClient = nil
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

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
