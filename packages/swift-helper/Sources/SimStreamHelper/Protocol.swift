import Foundation

// Wire protocol: [type: UInt8][length: UInt32 big-endian][payload: bytes]
enum MessageType: UInt8 {
    case h264Frame = 0x01      // helper → client: H.264 NALU data
    case touchEvent = 0x02     // client → helper: JSON touch event
    case config = 0x03         // helper → client: JSON config (screen size, etc.)
    case sps = 0x04            // helper → client: H.264 SPS NALU
    case pps = 0x05            // helper → client: H.264 PPS NALU
    case keyFrame = 0x06       // helper → client: H.264 IDR (key) frame
}

struct TouchEventPayload: Codable {
    let type: String  // "begin", "move", "end"
    let x: Double     // normalized 0..1
    let y: Double     // normalized 0..1
}

struct ConfigPayload: Codable {
    let width: Int
    let height: Int
    let fps: Int
}

func encodeMessage(type: MessageType, payload: Data) -> Data {
    var data = Data(capacity: 1 + 4 + payload.count)
    data.append(type.rawValue)
    var length = UInt32(payload.count).bigEndian
    data.append(Data(bytes: &length, count: 4))
    data.append(payload)
    return data
}

struct MessageParser {
    private var buffer = Data()

    mutating func append(_ data: Data) {
        buffer.append(data)
    }

    mutating func nextMessage() -> (MessageType, Data)? {
        guard buffer.count >= 5 else { return nil }

        guard let type = MessageType(rawValue: buffer[0]) else {
            // Skip unknown message type
            buffer.removeFirst()
            return nextMessage()
        }

        let lengthBytes = buffer.subdata(in: 1..<5)
        let length = lengthBytes.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }

        guard buffer.count >= 5 + Int(length) else { return nil }

        let payload = buffer.subdata(in: 5..<(5 + Int(length)))
        buffer.removeSubrange(0..<(5 + Int(length)))
        return (type, payload)
    }
}
