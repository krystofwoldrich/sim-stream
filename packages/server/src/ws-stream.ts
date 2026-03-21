import type { ServerWebSocket } from "bun";
import type { TouchEventPayload } from "./protocol.js";

// WebSocket binary message types (browser ↔ server)
const WS_MSG_CONFIG = 0x01;
const WS_MSG_VIDEO_FRAME = 0x02;
const WS_MSG_TOUCH = 0x03;

const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB backpressure threshold

export interface WebSocketData {
  id: string;
}

export class WebSocketManager {
  private clients = new Set<ServerWebSocket<WebSocketData>>();
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private codecString: string | null = null;
  private screenWidth = 0;
  private screenHeight = 0;
  private frameTimestamp = 0;
  private fps = 60;
  private lastKeyFrameMessage: Buffer | null = null;
  private onTouch: ((touch: TouchEventPayload) => void) | null = null;

  setTouchHandler(handler: (touch: TouchEventPayload) => void): void {
    this.onTouch = handler;
  }

  setSPS(sps: Buffer): void {
    this.sps = sps;
    // Derive avc1 codec string from SPS: profile_idc, constraint_flags, level_idc
    if (sps.length >= 4) {
      const profile = sps[1]!.toString(16).padStart(2, "0");
      const compat = sps[2]!.toString(16).padStart(2, "0");
      const level = sps[3]!.toString(16).padStart(2, "0");
      this.codecString = `avc1.${profile}${compat}${level}`;
      console.log(`[ws-stream] Codec string: ${this.codecString}`);
    }
  }

  setPPS(pps: Buffer): void {
    this.pps = pps;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  setFps(fps: number): void {
    this.fps = fps;
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  addClient(ws: ServerWebSocket<WebSocketData>): void {
    this.clients.add(ws);
    console.log(
      `[ws-stream] Client connected: ${ws.data.id} (${this.clients.size} total)`,
    );

    // Send config if available
    if (this.screenWidth > 0 && this.codecString) {
      const config = JSON.stringify({
        type: "config",
        width: this.screenWidth,
        height: this.screenHeight,
        codec: this.codecString,
      });
      const payload = Buffer.from(config);
      const msg = Buffer.alloc(1 + payload.length);
      msg[0] = WS_MSG_CONFIG;
      payload.copy(msg, 1);
      ws.sendBinary(msg);
    }

    // Send last keyframe so late joiners see video immediately
    if (this.lastKeyFrameMessage) {
      ws.sendBinary(this.lastKeyFrameMessage);
    }
  }

  removeClient(ws: ServerWebSocket<WebSocketData>): void {
    this.clients.delete(ws);
    console.log(
      `[ws-stream] Client disconnected: ${ws.data.id} (${this.clients.size} total)`,
    );
  }

  handleMessage(
    _ws: ServerWebSocket<WebSocketData>,
    data: Buffer | string,
  ): void {
    if (typeof data === "string") return;
    if (data.length < 2) return;

    const type = data[0];
    if (type === WS_MSG_TOUCH) {
      try {
        const json = data.subarray(1).toString();
        const touch = JSON.parse(json) as TouchEventPayload;
        this.onTouch?.(touch);
      } catch {
        // ignore malformed touch
      }
    }
  }

  sendFrame(annexBData: Buffer, isKeyFrame: boolean): void {
    if (this.clients.size === 0) return;

    // Timestamp in microseconds for WebCodecs
    const timestampUs = this.frameTimestamp;
    this.frameTimestamp += Math.round(1_000_000 / this.fps);

    // Build frame payload: for keyframes, prepend SPS+PPS with start codes
    let framePayload: Buffer;
    if (isKeyFrame && this.sps && this.pps) {
      framePayload = Buffer.concat([
        ANNEX_B_START_CODE,
        this.sps,
        ANNEX_B_START_CODE,
        this.pps,
        annexBData,
      ]);
    } else {
      framePayload = annexBData;
    }

    // Header: [type:u8][keyframe:u8][timestamp:u64BE]
    const header = Buffer.alloc(10);
    header[0] = WS_MSG_VIDEO_FRAME;
    header[1] = isKeyFrame ? 1 : 0;
    header.writeBigUInt64BE(BigInt(timestampUs), 2);

    const message = Buffer.concat([header, framePayload]);

    // Store last keyframe for late joiners
    if (isKeyFrame) {
      this.lastKeyFrameMessage = message;
    }

    // Broadcast to all clients with backpressure check
    for (const ws of this.clients) {
      if (ws.getBufferedAmount() > MAX_BUFFERED_AMOUNT) {
        continue; // skip slow client
      }
      ws.sendBinary(message);
    }
  }

  stop(): void {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }
}
