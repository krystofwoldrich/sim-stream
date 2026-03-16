import { SwiftBridge } from "./swift-bridge.js";
import { WebRTCManager } from "./webrtc.js";

export interface SimStreamServerOptions {
  device: string; // Simulator UDID
  port?: number;
  host?: string;
}

export class SimStreamServer {
  private bridge: SwiftBridge | null = null;
  private webrtc = new WebRTCManager();
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
    // Setup WebRTC touch handler → bridge
    this.webrtc.setTouchHandler((touch) => {
      this.bridge?.sendTouch(touch);
    });

    // Start Swift helper bridge
    this.bridge = new SwiftBridge(this.options.device, {
      onConfig: (config) => {
        console.log(
          `[server] Screen config: ${config.width}x${config.height} @ ${config.fps}fps`,
        );
        this.webrtc.setScreenSize(config.width, config.height);
      },
      onSPS: (sps) => {
        console.log(`[server] Received SPS (${sps.length} bytes)`);
        this.webrtc.setSPS(sps);
      },
      onPPS: (pps) => {
        console.log(`[server] Received PPS (${pps.length} bytes)`);
        this.webrtc.setPPS(pps);
      },
      onFrame: (data, isKeyFrame) => {
        this.webrtc.sendFrame(data, isKeyFrame);
      },
    });

    await this.bridge.start();

    // Start HTTP server for signaling
    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.host,
      fetch: async (req) => {
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

        if (url.pathname === "/offer" && req.method === "POST") {
          return this.handleOffer(req, corsHeaders);
        }

        if (url.pathname === "/config" && req.method === "GET") {
          const size = this.webrtc.getScreenSize();
          return Response.json(size, { headers: corsHeaders });
        }

        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok" }, { headers: corsHeaders });
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders });
      },
    });

    console.log(
      `[server] Listening on http://${this.options.host}:${this.options.port}`,
    );
  }

  private async handleOffer(
    req: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    try {
      const body = (await req.json()) as { sdp: string };
      if (!body.sdp) {
        return Response.json(
          { error: "Missing sdp field" },
          { status: 400, headers: corsHeaders },
        );
      }

      const answer = await this.webrtc.handleOffer(body.sdp);
      return Response.json(answer, { headers: corsHeaders });
    } catch (err) {
      console.error("[server] Offer handling error:", err);
      return Response.json(
        { error: String(err) },
        { status: 500, headers: corsHeaders },
      );
    }
  }

  stop(): void {
    this.webrtc.stop();
    this.bridge?.stop();
    this.server?.stop();
    console.log("[server] Stopped");
  }
}
