// Wire protocol matching Swift helper: [type: u8][length: u32 BE][payload]
export enum MessageType {
  H264Frame = 0x01,
  TouchEvent = 0x02,
  Config = 0x03,
  SPS = 0x04,
  PPS = 0x05,
  KeyFrame = 0x06,
  ButtonEvent = 0x07,
}

export interface TouchEventPayload {
  type: "begin" | "move" | "end";
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export interface ConfigPayload {
  width: number;
  height: number;
  fps: number;
}

export function encodeMessage(type: MessageType, payload: Buffer): Buffer {
  const msg = Buffer.alloc(1 + 4 + payload.length);
  msg.writeUInt8(type, 0);
  msg.writeUInt32BE(payload.length, 1);
  payload.copy(msg, 5);
  return msg;
}

export class MessageParser {
  private buffer = Buffer.alloc(0);

  append(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  nextMessage(): { type: MessageType; payload: Buffer } | null {
    if (this.buffer.length < 5) return null;

    const type = this.buffer.readUInt8(0) as MessageType;
    const length = this.buffer.readUInt32BE(1);

    if (this.buffer.length < 5 + length) return null;

    const payload = this.buffer.subarray(5, 5 + length);
    this.buffer = this.buffer.subarray(5 + length);
    return { type, payload };
  }
}
