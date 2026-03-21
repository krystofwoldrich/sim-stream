import { SwiftBridge } from "./swift-bridge.js";
import { WebSocketManager, type WebSocketData } from "./ws-stream.js";

export interface SimStreamServerOptions {
  device: string; // Simulator UDID
  port?: number;
  host?: string;
}

export class SimStreamServer {
  private bridge: SwiftBridge | null = null;
  private wsManager = new WebSocketManager();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private options: Required<SimStreamServerOptions>;

  constructor(options: SimStreamServerOptions) {
    this.options = {
      port: 3100,
      host: "0.0.0.0",
      ...options,
    };
  }

  async start(): Promise<void> {
    // Setup touch handler → bridge
    this.wsManager.setTouchHandler((touch) => {
      this.bridge?.sendTouch(touch);
    });

    // Start Swift helper bridge
    this.bridge = new SwiftBridge(this.options.device, {
      onConfig: (config) => {
        console.log(
          `[server] Screen config: ${config.width}x${config.height} @ ${config.fps}fps`,
        );
        this.wsManager.setScreenSize(config.width, config.height);
        this.wsManager.setFps(config.fps);
      },
      onSPS: (sps) => {
        console.log(`[server] Received SPS (${sps.length} bytes)`);
        this.wsManager.setSPS(sps);
      },
      onPPS: (pps) => {
        console.log(`[server] Received PPS (${pps.length} bytes)`);
        this.wsManager.setPPS(pps);
      },
      onFrame: (data, isKeyFrame) => {
        this.wsManager.sendFrame(data, isKeyFrame);
      },
    });

    await this.bridge.start();

    const wsManager = this.wsManager;

    // Start HTTP + WebSocket server
    this.server = Bun.serve<WebSocketData>({
      port: this.options.port,
      hostname: this.options.host,
      fetch(req, server) {
        const url = new URL(req.url);

        // CORS headers for all responses
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req, {
            data: { id: crypto.randomUUID() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", {
            status: 400,
            headers: corsHeaders,
          });
        }

        if (url.pathname === "/config" && req.method === "GET") {
          const size = wsManager.getScreenSize();
          return Response.json(size, { headers: corsHeaders });
        }

        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok" }, { headers: corsHeaders });
        }

        return new Response("Not Found", {
          status: 404,
          headers: corsHeaders,
        });
      },
      websocket: {
        open(ws) {
          wsManager.addClient(ws);
        },
        message(ws, data) {
          wsManager.handleMessage(
            ws,
            typeof data === "string" ? data : Buffer.from(data),
          );
        },
        close(ws) {
          wsManager.removeClient(ws);
        },
        perMessageDeflate: false,
        maxPayloadLength: 16 * 1024 * 1024,
      },
    });

    console.log(
      `[server] Listening on http://${this.options.host}:${this.options.port}`,
    );
  }

  stop(): void {
    this.wsManager.stop();
    this.bridge?.stop();
    this.server?.stop();
    console.log("[server] Stopped");
  }
}
