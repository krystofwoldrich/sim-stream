#!/usr/bin/env bun
import { SimStreamServer } from "@sim-stream/server";
import { execSync } from "child_process";

function parseArgs(): { device: string; port: number } {
  const args = process.argv.slice(2);

  if (args[0] === "start") {
    args.shift();
  }

  let device: string | null = null;
  let port = 3100;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--device" || arg === "-d") {
      device = args[++i] ?? null;
    } else if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i] ?? "3100", 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!device) {
    // Try to find a booted device
    device = findBootedDevice();
    if (!device) {
      console.error("Error: No --device specified and no booted simulator found.");
      console.error("Usage: sim-stream start --device <name-or-udid>");
      console.error("\nBooted simulators:");
      listDevices();
      process.exit(1);
    }
  }

  // Resolve device name to UDID if needed
  const udid = resolveDevice(device);
  return { device: udid, port };
}

function printHelp(): void {
  console.log(`
sim-stream - Stream iOS Simulator to the web

Usage:
  sim-stream start --device <name-or-udid> [--port <port>]

Options:
  -d, --device  Simulator device name or UDID (default: first booted device)
  -p, --port    HTTP server port (default: 3100)
  -h, --help    Show this help
`);
}

function findBootedDevice(): string | null {
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };

    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") {
          console.log(`Found booted simulator: ${device.name} (${device.udid})`);
          return device.udid;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveDevice(nameOrUDID: string): string {
  // If it looks like a UUID, use it directly
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(nameOrUDID)) {
    return nameOrUDID;
  }

  // Otherwise, find the device by name
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };

    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.name.toLowerCase() === nameOrUDID.toLowerCase()) {
          console.log(`Resolved "${nameOrUDID}" → ${device.udid} (${device.state})`);
          return device.udid;
        }
      }
    }
  } catch {
    // ignore
  }

  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}

function listDevices(): void {
  try {
    const output = execSync("xcrun simctl list devices booted", {
      encoding: "utf-8",
    });
    console.log(output);
  } catch {
    console.error("  (failed to list devices)");
  }
}

async function main(): Promise<void> {
  const { device, port } = parseArgs();

  const server = new SimStreamServer({ device, port });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });

  await server.start();
  console.log(`\nOpen your browser at: http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
