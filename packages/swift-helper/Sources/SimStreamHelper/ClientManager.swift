import Foundation
import Swifter

/// Manages WebSocket clients and broadcasts video frames.
final class ClientManager {
    private var sessions: [ObjectIdentifier: WebSocketSession] = [:]
    private let queue = DispatchQueue(label: "client-manager")

    private var sps: Data?
    private var pps: Data?
    private var codecString: String?
    private var screenWidth = 0
    private var screenHeight = 0
    private var fps = 60
    private var frameTimestamp: UInt64 = 0
    private var lastKeyFrameMessage: Data?

    var onTouch: ((TouchEventPayload) -> Void)?
    var onButton: ((String) -> Void)?

    private static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    // MARK: - Configuration

    func setSPS(_ data: Data) {
        queue.async {
            self.sps = data
            if data.count >= 4 {
                let profile = String(format: "%02x", data[1])
                let compat = String(format: "%02x", data[2])
                let level = String(format: "%02x", data[3])
                self.codecString = "avc1.\(profile)\(compat)\(level)"
                print("[clients] Codec string: \(self.codecString!)")
            }
        }
    }

    func setPPS(_ data: Data) {
        queue.async { self.pps = data }
    }

    func setScreenSize(width: Int, height: Int) {
        queue.async {
            self.screenWidth = width
            self.screenHeight = height
        }
    }

    func setFps(_ fps: Int) {
        queue.async { self.fps = fps }
    }

    func getScreenSize() -> (width: Int, height: Int) {
        return (screenWidth, screenHeight)
    }

    // MARK: - Client Management

    func addClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.sessions[id] = session
            print("[clients] Connected (\(self.sessions.count) total)")

            // Send config
            if self.screenWidth > 0, let codec = self.codecString {
                let config = """
                {"type":"config","width":\(self.screenWidth),"height":\(self.screenHeight),"codec":"\(codec)"}
                """
                var msg = Data([0x01])
                msg.append(Data(config.utf8))
                session.writeBinary([UInt8](msg))
            }

            // Send last keyframe for late joiners
            if let keyframe = self.lastKeyFrameMessage {
                session.writeBinary([UInt8](keyframe))
            }
        }
    }

    func removeClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.sessions.removeValue(forKey: id)
            print("[clients] Disconnected (\(self.sessions.count) total)")
        }
    }

    // MARK: - Message Handling

    func handleMessage(from session: WebSocketSession, data: Data) {
        guard data.count >= 1 else { return }
        let type = data[0]

        if type == 0x03 { // WS_MSG_TOUCH
            guard let json = try? JSONDecoder().decode(TouchEventPayload.self, from: data[1...]) else { return }
            onTouch?(json)
        } else if type == 0x04 { // WS_MSG_BUTTON
            guard let json = try? JSONDecoder().decode(ButtonEventPayload.self, from: data[1...]) else { return }
            onButton?(json.button)
        }
    }

    // MARK: - Frame Broadcasting

    func broadcastFrame(annexBData: Data, isKeyFrame: Bool) {
        queue.async {
            let timestampUs = self.frameTimestamp
            self.frameTimestamp += UInt64(1_000_000 / self.fps)

            // Build frame payload
            var framePayload: Data
            if isKeyFrame, let sps = self.sps, let pps = self.pps {
                framePayload = Data()
                framePayload.append(Self.startCode)
                framePayload.append(sps)
                framePayload.append(Self.startCode)
                framePayload.append(pps)
                framePayload.append(annexBData)
            } else {
                framePayload = annexBData
            }

            // Header: [type:u8][keyframe:u8][timestamp:u64BE]
            var message = Data(capacity: 10 + framePayload.count)
            message.append(0x02)
            message.append(isKeyFrame ? 1 : 0)
            var ts = timestampUs.bigEndian
            message.append(Data(bytes: &ts, count: 8))
            message.append(framePayload)

            // Store keyframe for late joiners
            if isKeyFrame {
                self.lastKeyFrameMessage = message
            }

            guard !self.sessions.isEmpty else { return }

            let bytes = [UInt8](message)
            for (_, session) in self.sessions {
                session.writeBinary(bytes)
            }
        }
    }

    func stop() {
        queue.async {
            self.sessions.removeAll()
        }
    }
}
