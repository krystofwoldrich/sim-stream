import { useCallback, useRef, type CSSProperties, type MouseEvent } from "react";
import { useWebSocketStream } from "./useWebSocketStream.js";

export interface SimulatorStreamProps {
  url: string;
  device: string;
  style?: CSSProperties;
  className?: string;
}

export function SimulatorStream({
  url,
  style,
  className,
}: SimulatorStreamProps) {
  const { imgRef, sendTouch, sendButton, connected, error, screenSize, fps, streamUrl } =
    useWebSocketStream({ url });

  const lastHomeClickRef = useRef(0);

  const homeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHomeClick = useCallback(() => {
    const now = Date.now();
    const timeSinceLast = now - lastHomeClickRef.current;
    lastHomeClickRef.current = now;

    if (timeSinceLast < 300) {
      // Double-click: cancel pending single press, send app switcher
      if (homeTimerRef.current) {
        clearTimeout(homeTimerRef.current);
        homeTimerRef.current = null;
      }
      sendButton("app_switcher");
    } else {
      // Delay single press to detect potential double-click
      homeTimerRef.current = setTimeout(() => {
        sendButton("home");
        homeTimerRef.current = null;
      }, 300);
    }
  }, [sendButton]);

  const handleTouch = useCallback(
    (type: "begin" | "move" | "end", event: MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img) return;

      const rect = img.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      sendTouch({ type, x, y });
    },
    [imgRef, sendTouch],
  );

  const aspectRatio =
    screenSize ? `${screenSize.width} / ${screenSize.height}` : "9 / 19.5";

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        border: "1px solid rgba(255,255,255,0.12)",
        ...style,
      }}
      className={className}
    >
      <div style={{ position: "relative" }}>
        <img
          ref={imgRef}
          src={streamUrl}
          draggable={false}
          onMouseDown={(e) => { e.preventDefault(); handleTouch("begin", e); }}
          onMouseMove={(e) => {
            if (e.buttons > 0) handleTouch("move", e);
          }}
          onMouseUp={(e) => handleTouch("end", e)}
          onMouseLeave={(e) => {
            if (e.buttons > 0) handleTouch("end", e);
          }}
          style={{
            width: "100%",
            aspectRatio,
            cursor: "pointer",
            display: "block",
            objectFit: "contain",
          }}
        />
        {!connected && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#888",
              fontSize: 14,
              background: "rgba(0,0,0,0.8)",
            }}
          >
            Connecting...
          </div>
        )}
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#f44",
              fontSize: 14,
              background: "rgba(0,0,0,0.8)",
              padding: 20,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderTop: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <button
          onClick={handleHomeClick}
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#aaa",
            fontSize: 11,
            fontFamily: "monospace",
            padding: "2px 10px",
            cursor: "pointer",
            borderRadius: 4,
          }}
        >
          Home
        </button>
        <span
          style={{
            color: fps > 0 ? "#4f4" : "#888",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          {fps} fps
        </span>
      </div>
    </div>
  );
}
