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

guard args.count >= 3 else {
    fputs("Usage: sim-stream-helper <device-udid> <socket-path>\n", stderr)
    exit(1)
}

let deviceUDID = args[1]
let socketPath = args[2]

print("[main] Starting sim-stream-helper (headless)")
print("[main] Device UDID: \(deviceUDID)")
print("[main] Socket path: \(socketPath)")

let socketServer = SocketServer(socketPath: socketPath)
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

// Start socket server
do {
    try socketServer.start { type, payload in
        switch type {
        case .touchEvent:
            if let touch = try? JSONDecoder().decode(TouchEventPayload.self, from: payload) {
                hidInjector.sendTouch(type: touch.type, x: touch.x, y: touch.y,
                                      screenWidth: screenWidth, screenHeight: screenHeight)
            }
        case .buttonEvent:
            if let btn = try? JSONDecoder().decode(ButtonEventPayload.self, from: payload) {
                hidInjector.sendButton(button: btn.button, deviceUDID: deviceUDID)
            }
        default:
            break
        }
    }
} catch {
    print("[main] Failed to start socket server: \(error.localizedDescription)")
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
                        socketServer.broadcast(type: .sps, payload: sps)
                        socketServer.broadcast(type: .pps, payload: pps)
                        print("[encoder] Sent SPS (\(sps.count) bytes) and PPS (\(pps.count) bytes)")
                    },
                    onEncodedFrame: { data, isKeyFrame in
                        let type: MessageType = isKeyFrame ? .keyFrame : .h264Frame
                        socketServer.broadcast(type: type, payload: data)
                    }
                )
                encoderReady = true
                print("[encoder] VideoToolbox encoder ready at \(w)x\(h)")

                // Send config
                let config = ConfigPayload(width: w, height: h, fps: 60)
                if let configData = try? JSONEncoder().encode(config) {
                    socketServer.broadcast(type: .config, payload: configData)
                }
            } catch {
                print("[encoder] Setup failed: \(error.localizedDescription)")
            }
        }

        if encoderReady {
            videoEncoder.encode(pixelBuffer: pixelBuffer, timestamp: timestamp)
        }
    }

    print("[main] Capture started, waiting for frames...")
} catch {
    print("[main] Failed to start capture: \(error.localizedDescription)")
    exit(1)
}

// Shutdown handlers
signal(SIGINT) { _ in
    print("\n[main] Shutting down...")
    frameCapture.stop()
    videoEncoder.stop()
    socketServer.stop()
    exit(0)
}

signal(SIGTERM) { _ in
    frameCapture.stop()
    videoEncoder.stop()
    socketServer.stop()
    exit(0)
}

RunLoop.main.run()
