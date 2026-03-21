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

    // FPS counter: fetch the MJPEG stream separately to count boundary markers
    const fpsAbort = new AbortController();
    fpsIntervalRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    (async () => {
      try {
        const res = await fetch(`${url}/stream.mjpeg`, { signal: fpsAbort.signal });
        const reader = res.body?.getReader();
        if (!reader) return;

        const boundary = new TextEncoder().encode("--frame");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Count boundary occurrences in this chunk
          if (value) {
            for (let i = 0; i <= value.length - boundary.length; i++) {
              let match = true;
              for (let j = 0; j < boundary.length; j++) {
                if (value[i + j] !== boundary[j]) { match = false; break; }
              }
              if (match) frameCountRef.current++;
            }
          }
        }
      } catch {
        // aborted on cleanup
      }
    })();

    return () => {
      fpsAbort.abort();
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
      ws.close();
      wsRef.current = null;
    };
  }, [url]);

  return { imgRef, sendTouch, sendButton, connected, error, screenSize, fps, streamUrl };
}
