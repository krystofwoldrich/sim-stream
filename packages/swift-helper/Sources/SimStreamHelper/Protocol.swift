import Foundation

// WebSocket binary message types (browser ↔ server)
enum WSMessageType: UInt8 {
    case config = 0x01       // server → client: JSON config
    case videoFrame = 0x02   // server → client: H.264 frame data
    case touch = 0x03        // client → server: JSON touch event
    case button = 0x04       // client → server: JSON button event
}

struct TouchEventPayload: Codable {
    let type: String  // "begin", "move", "end"
    let x: Double     // normalized 0..1
    let y: Double     // normalized 0..1
}

struct ButtonEventPayload: Codable {
    let button: String  // "home"
}

struct ConfigPayload: Codable {
    let width: Int
    let height: Int
    let fps: Int
}
