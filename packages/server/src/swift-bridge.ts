import { spawn, type Subprocess } from "bun";
import { createConnection, type Socket } from "net";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  MessageType,
  MessageParser,
  encodeMessage,
  type ConfigPayload,
  type TouchEventPayload,
} from "./protocol.js";

export interface SwiftBridgeEvents {
  onConfig: (config: ConfigPayload) => void;
  onSPS: (sps: Buffer) => void;
  onPPS: (pps: Buffer) => void;
  onFrame: (data: Buffer, isKeyFrame: boolean) => void;
}

export class SwiftBridge {
  private process: Subprocess | null = null;
  private socket: Socket | null = null;
  private parser = new MessageParser();
  private socketPath: string;
  private events: SwiftBridgeEvents;

  constructor(
    private deviceUDID: string,
    events: SwiftBridgeEvents,
  ) {
    this.socketPath = resolve(tmpdir(), `sim-stream-${Date.now()}.sock`);
    this.events = events;
  }

  async start(): Promise<void> {
    const helperPath = this.findHelperBinary();
    console.log(`[bridge] Starting swift helper: ${helperPath}`);
    console.log(`[bridge] Device UDID: ${this.deviceUDID}`);
    console.log(`[bridge] Socket: ${this.socketPath}`);

    this.process = spawn({
      cmd: [helperPath, this.deviceUDID, this.socketPath],
      stdout: "inherit",
      stderr: "inherit",
    });

    // Wait for the socket to be available
    await this.waitForSocket();
    await this.connectSocket();
  }

  private findHelperBinary(): string {
    // Look for the binary relative to this package
    const candidates = [
      resolve(import.meta.dir, "../../swift-helper/bin/sim-stream-helper"),
      resolve(import.meta.dir, "../../../packages/swift-helper/bin/sim-stream-helper"),
    ];

    for (const candidate of candidates) {
      if (Bun.file(candidate).size > 0) {
        return candidate;
      }
    }

    throw new Error(
      `sim-stream-helper binary not found. Run 'bun run build:swift' first. Checked: ${candidates.join(", ")}`,
    );
  }

  private async waitForSocket(): Promise<void> {
    const { existsSync } = await import("fs");
    const maxAttempts = 50;
    for (let i = 0; i < maxAttempts; i++) {
      if (existsSync(this.socketPath)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Swift helper socket not available after 5s");
  }

  private async connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => {
        console.log("[bridge] Connected to swift helper");
        resolve();
      });

      this.socket.on("data", (data: Buffer) => {
        this.parser.append(data);
        let msg;
        while ((msg = this.parser.nextMessage()) !== null) {
          this.handleMessage(msg.type, msg.payload);
        }
      });

      this.socket.on("error", (err) => {
        console.error("[bridge] Socket error:", err.message);
        reject(err);
      });

      this.socket.on("close", () => {
        console.log("[bridge] Socket closed");
      });
    });
  }

  private handleMessage(type: MessageType, payload: Buffer): void {
    switch (type) {
      case MessageType.Config: {
        const config = JSON.parse(payload.toString()) as ConfigPayload;
        this.events.onConfig(config);
        break;
      }
      case MessageType.SPS:
        this.events.onSPS(payload);
        break;
      case MessageType.PPS:
        this.events.onPPS(payload);
        break;
      case MessageType.KeyFrame:
        this.events.onFrame(Buffer.from(payload), true);
        break;
      case MessageType.H264Frame:
        this.events.onFrame(Buffer.from(payload), false);
        break;
    }
  }

  sendTouch(touch: TouchEventPayload): void {
    if (!this.socket) return;
    const payload = Buffer.from(JSON.stringify(touch));
    const msg = encodeMessage(MessageType.TouchEvent, payload);
    this.socket.write(msg);
  }

  stop(): void {
    this.socket?.destroy();
    this.process?.kill();
    try {
      require("fs").unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }
}
