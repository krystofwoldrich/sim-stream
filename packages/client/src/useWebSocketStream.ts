import { useCallback, useEffect, useRef, useState } from "react";

// WebSocket binary message types (must match server ws-stream.ts)
const WS_MSG_CONFIG = 0x01;
const WS_MSG_VIDEO_FRAME = 0x02;
const WS_MSG_TOUCH = 0x03;

export interface UseWebSocketStreamOptions {
  url: string;
}

export interface UseWebSocketStreamResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  sendTouch: (touch: { type: "begin" | "move" | "end"; x: number; y: number }) => void;
  connected: boolean;
  error: string | null;
  screenSize: { width: number; height: number } | null;
  fps: number;
}

export function useWebSocketStream({
  url,
}: UseWebSocketStreamOptions): UseWebSocketStreamResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenSize, setScreenSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (typeof VideoDecoder === "undefined") {
      setError(
        "WebCodecs API not supported. Use Chrome, Edge, or Safari 16.4+.",
      );
      return;
    }

    // Convert HTTP URL to WebSocket URL
    const wsUrl = url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    let decoder: VideoDecoder | null = null;
    let pendingFrame: VideoFrame | null = null;
    let rafId: number | null = null;

    // Render loop: only draw the latest decoded frame on each display refresh
    function renderLoop() {
      rafId = requestAnimationFrame(renderLoop);

      if (!pendingFrame) return;

      const frame = pendingFrame;
      pendingFrame = null;

      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }

      if (
        canvas.width !== frame.displayWidth ||
        canvas.height !== frame.displayHeight
      ) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(frame, 0, 0);
      }
      frame.close();
      frameCountRef.current++;
    }

    rafId = requestAnimationFrame(renderLoop);

    function configureDecoder(codec: string) {
      // Close previous decoder if any
      if (decoder && decoder.state !== "closed") {
        decoder.close();
      }

      decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          // Keep only the latest frame, close any previous pending frame
          if (pendingFrame) {
            pendingFrame.close();
          }
          pendingFrame = frame;
        },
        error: (e) => {
          console.error("[webcodecs] Decoder error:", e.message);
        },
      });

      decoder.configure({
        codec,
        optimizeForLatency: true,
      });

      decoderRef.current = decoder;
      console.log(`[webcodecs] Decoder configured: ${codec}`);
    }

    // FPS counter: update every second
    fpsIntervalRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    ws.onopen = () => {
      console.log("[ws-stream] Connected");
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 2) return;

      const msgType = data[0];

      if (msgType === WS_MSG_CONFIG) {
        try {
          const json = new TextDecoder().decode(data.subarray(1));
          const config = JSON.parse(json) as {
            type: string;
            width: number;
            height: number;
            codec: string;
          };
          setScreenSize({ width: config.width, height: config.height });
          configureDecoder(config.codec);
        } catch {
          // ignore malformed config
        }
        return;
      }

      if (msgType === WS_MSG_VIDEO_FRAME) {
        if (!decoder || decoder.state !== "configured") return;
        if (data.length < 10) return;

        const isKeyFrame = data[1] === 1;
        const view = new DataView(event.data as ArrayBuffer);
        const timestampUs = Number(view.getBigUint64(2));
        const frameData = data.subarray(10);

        try {
          const chunk = new EncodedVideoChunk({
            type: isKeyFrame ? "key" : "delta",
            timestamp: timestampUs,
            data: frameData,
          });
          decoder.decode(chunk);
        } catch {
          // decoder may reject frames before first keyframe
        }
        return;
      }
    };

    ws.onclose = () => {
      console.log("[ws-stream] Disconnected");
      setConnected(false);
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
      setConnected(false);
    };

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (pendingFrame) { pendingFrame.close(); pendingFrame = null; }
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
      ws.close();
      wsRef.current = null;
      if (decoder && decoder.state !== "closed") {
        decoder.close();
      }
      decoderRef.current = null;
    };
  }, [url]);

  return { canvasRef, sendTouch, connected, error, screenSize, fps };
}
