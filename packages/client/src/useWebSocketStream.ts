import { useCallback, useEffect, useRef, useState } from "react";

// WebSocket binary message types (input only)
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;

export interface UseWebSocketStreamOptions {
  url: string;
}

export interface UseWebSocketStreamResult {
  imgRef: React.RefObject<HTMLImageElement | null>;
  sendTouch: (touch: { type: "begin" | "move" | "end"; x: number; y: number }) => void;
  sendButton: (button: string) => void;
  connected: boolean;
  error: string | null;
  screenSize: { width: number; height: number } | null;
  fps: number;
  streamUrl: string;
}

export function useWebSocketStream({
  url,
}: UseWebSocketStreamOptions): UseWebSocketStreamResult {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenSize, setScreenSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const streamUrl = `${url}/stream.mjpeg`;

  const sendTouch = useCallback(
    (touch: { type: "begin" | "move" | "end"; x: number; y: number }) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const json = new TextEncoder().encode(JSON.stringify(touch));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = WS_MSG_TOUCH;
      msg.set(json, 1);
      ws.send(msg);
    },
    [],
  );

  const sendButton = useCallback((button: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const json = new TextEncoder().encode(JSON.stringify({ button }));
    const msg = new Uint8Array(1 + json.length);
    msg[0] = WS_MSG_BUTTON;
    msg.set(json, 1);
    ws.send(msg);
  }, []);

  useEffect(() => {
    // Fetch config for screen size
    fetch(`${url}/config`)
      .then((r) => r.json())
      .then((config: { width: number; height: number }) => {
        if (config.width > 0 && config.height > 0) {
          setScreenSize({ width: config.width, height: config.height });
        }
      })
      .catch(() => {});

    // WebSocket for input only
    const wsUrl = url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
      setConnected(false);
    };

    // FPS counter: count img repaints via a polling check on naturalWidth changes
    // For MJPEG, we use requestAnimationFrame to detect visual updates
    let lastFrameTime = 0;
    let rafId: number;
    fpsIntervalRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    function checkFrame() {
      rafId = requestAnimationFrame(checkFrame);
      const img = imgRef.current;
      if (!img || !img.complete || img.naturalWidth === 0) return;
      // MJPEG streams update the img src continuously;
      // count each animation frame where the image is loaded as a rendered frame
      const now = performance.now();
      if (now !== lastFrameTime) {
        frameCountRef.current++;
        lastFrameTime = now;
      }
    }
    rafId = requestAnimationFrame(checkFrame);

    return () => {
      cancelAnimationFrame(rafId);
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
      ws.close();
      wsRef.current = null;
    };
  }, [url]);

  return { imgRef, sendTouch, sendButton, connected, error, screenSize, fps, streamUrl };
}
