# sim-stream

Stream an iOS Simulator screen to the browser with touch input support.

Built with Swift (server + HID injection) and React (client component). Uses MJPEG for low-latency video and WebSocket for input.

## CLI Usage

```bash
# Auto-detect booted simulator
sim-stream start

# Specify device by name or UDID
sim-stream start --device "iPhone 16 Pro"
sim-stream start --device 7A1B2C3D-4E5F-6789-ABCD-EF0123456789

# Custom port
sim-stream start --port 8080
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--device` | `-d` | first booted | Simulator name or UDID |
| `--port` | `-p` | `3100` | HTTP server port |
| `--help` | `-h` | | Show help |

## React Component

Install the client package and use the `<SimulatorStream>` component to embed a simulator stream in your React app.

```tsx
import { SimulatorStream } from "@sim-stream/client";

function App() {
  return (
    <SimulatorStream
      url="http://localhost:3100"
      device="iPhone 16 Pro"
      style={{ width: 360 }}
    />
  );
}
```

### Touch Gestures

| Input | Action |
|-------|--------|
| Click / Drag | Single finger touch |
| Option + Drag | Two-finger scroll |
| Shift + Drag | Pinch to zoom |
| Home button | Single click = Home, double click = App Switcher |

### Headless Usage

Use the `useWebSocketStream` hook directly for custom UIs:

```tsx
import { useWebSocketStream } from "@sim-stream/client";

function CustomStream() {
  const { imgRef, sendTouch, sendButton, connected, fps, streamUrl } =
    useWebSocketStream({ url: "http://localhost:3100" });

  return (
    <div>
      <p>{connected ? `Connected (${fps} fps)` : "Disconnected"}</p>
      <img ref={imgRef} src={streamUrl} />
      <button onClick={() => sendButton("home")}>Home</button>
    </div>
  );
}
```

## Quick Start

```bash
# Install dependencies
bun install

# Build the Swift helper + all packages
bun run build

# Start streaming (auto-detects booted simulator)
bun run dev:cli
```

Open `http://localhost:3100` in your browser.

## Packages

| Package | Description |
|---------|-------------|
| `apps/cli` | CLI entry point (`sim-stream`) |
| `apps/web` | Demo web app |
| `packages/server` | HTTP/WebSocket server (Bun) |
| `packages/client` | React `<SimulatorStream>` component |
| `packages/swift-helper` | Native Swift binary for screen capture and HID input |

## Development

```bash
# Run the web demo app
bun run dev:web

# Run the CLI in dev mode
bun run dev:cli

# Run tests
bun test

# Run e2e tests
bun run test:e2e
```
