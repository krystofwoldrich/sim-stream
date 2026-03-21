import { spawn, type Subprocess } from "bun";
import { resolve } from "path";

export interface SimStreamServerOptions {
  device: string; // Simulator UDID
  port?: number;
  host?: string;
}

export class SimStreamServer {
  private process: Subprocess | null = null;
  private options: Required<SimStreamServerOptions>;

  constructor(options: SimStreamServerOptions) {
    this.options = {
      port: 3100,
      host: "0.0.0.0",
      ...options,
    };
  }

  async start(): Promise<void> {
    const helperPath = this.findHelperBinary();
    console.log(`[server] Starting: ${helperPath}`);
    console.log(`[server] Device: ${this.options.device}`);
    console.log(`[server] Port: ${this.options.port}`);

    this.process = spawn({
      cmd: [
        helperPath,
        this.options.device,
        "--port",
        String(this.options.port),
      ],
      stdout: "inherit",
      stderr: "inherit",
    });

    // Wait a moment for the server to start
    await new Promise((r) => setTimeout(r, 500));
  }

  private findHelperBinary(): string {
    const candidates = [
      resolve(import.meta.dir, "../../swift-helper/bin/sim-stream-helper"),
      resolve(
        import.meta.dir,
        "../../../packages/swift-helper/bin/sim-stream-helper",
      ),
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

  stop(): void {
    this.process?.kill();
    this.process = null;
    console.log("[server] Stopped");
  }
}
