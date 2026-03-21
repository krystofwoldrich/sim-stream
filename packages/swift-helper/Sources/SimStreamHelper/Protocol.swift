import Foundation

// WebSocket binary message types (used for input only now)
enum WSMessageType: UInt8 {
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
