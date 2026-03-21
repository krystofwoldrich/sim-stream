import Foundation
import CoreVideo
import AppKit

// Force unbuffered output
setbuf(stdout, nil)
setbuf(stderr, nil)

// Initialize AppKit (needed for HID touch subprocess)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let args = CommandLine.arguments

guard args.count >= 2 else {
    fputs("Usage: sim-stream-helper <device-udid> [--port 3100]\n", stderr)
    exit(1)
}

let deviceUDID = args[1]
var port: UInt16 = 3100

// Parse optional --port flag
if let portIdx = args.firstIndex(of: "--port"), portIdx + 1 < args.count,
   let p = UInt16(args[portIdx + 1]) {
    port = p
}

print("[main] Starting sim-stream-helper")
print("[main] Device UDID: \(deviceUDID)")
print("[main] Port: \(port)")

let httpServer = HTTPServer(port: port)
let frameCapture = FrameCapture()
let videoEncoder = VideoEncoder()
let hidInjector = HIDInjector()

var screenWidth = 0
var screenHeight = 0
var encoderReady = false

// Setup HID injector
do {
    try hidInjector.setup(deviceUDID: deviceUDID)
} catch {
    print("[main] Warning: HID setup failed: \(error.localizedDescription)")
}

// Wire client manager → HID injector
httpServer.clientManager.onTouch = { touch in
    hidInjector.sendTouch(type: touch.type, x: touch.x, y: touch.y,
                          screenWidth: screenWidth, screenHeight: screenHeight)
}
httpServer.clientManager.onButton = { button in
    hidInjector.sendButton(button: button, deviceUDID: deviceUDID)
}

// Start HTTP + WebSocket server
do {
    try httpServer.start()
} catch {
    print("[main] Failed to start server: \(error.localizedDescription)")
    exit(1)
}

// Start frame capture — encoder is initialized lazily on first frame
do {
    try frameCapture.start(deviceUDID: deviceUDID) { pixelBuffer, timestamp in
        let w = CVPixelBufferGetWidth(pixelBuffer)
        let h = CVPixelBufferGetHeight(pixelBuffer)

        // Initialize encoder on first frame with actual dimensions
        if !encoderReady || w != screenWidth || h != screenHeight {
            screenWidth = w
            screenHeight = h
            print("[main] Frame dimensions: \(w)x\(h), (re)initializing encoder")

            videoEncoder.stop()
            do {
                try videoEncoder.setup(
                    width: Int32(w),
                    height: Int32(h),
                    fps: 60,
                    onParameterSets: { sps, pps in
                        httpServer.clientManager.setSPS(sps)
                        httpServer.clientManager.setPPS(pps)
                        print("[encoder] Sent SPS (\(sps.count) bytes) and PPS (\(pps.count) bytes)")
                    },
                    onEncodedFrame: { data, isKeyFrame in
                        httpServer.clientManager.broadcastFrame(annexBData: data, isKeyFrame: isKeyFrame)
                    }
                )
                encoderReady = true
                print("[encoder] VideoToolbox encoder ready at \(w)x\(h)")

                // Update client manager config
                httpServer.clientManager.setScreenSize(width: w, height: h)
                httpServer.clientManager.setFps(60)
            } catch {
                print("[encoder] Setup failed: \(error.localizedDescription)")
            }
        }

        if encoderReady {
            videoEncoder.encode(pixelBuffer: pixelBuffer, timestamp: timestamp)
        }
    }

    print("[main] Capture started, waiting for frames...")
    print("\nOpen your browser at: http://localhost:\(port)")
    print("Press Ctrl+C to stop.\n")
} catch {
    print("[main] Failed to start capture: \(error.localizedDescription)")
    exit(1)
}

// Shutdown handlers
signal(SIGINT) { _ in
    print("\n[main] Shutting down...")
    frameCapture.stop()
    videoEncoder.stop()
    httpServer.stop()
    exit(0)
}

signal(SIGTERM) { _ in
    frameCapture.stop()
    videoEncoder.stop()
    httpServer.stop()
    exit(0)
}

RunLoop.main.run()
