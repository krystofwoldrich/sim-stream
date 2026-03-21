import { useCallback, type CSSProperties, type MouseEvent } from "react";
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
  const { canvasRef, sendTouch, connected, error, screenSize, fps } =
    useWebSocketStream({ url });

  const handleTouch = useCallback(
    (type: "begin" | "move" | "end", event: MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      sendTouch({ type, x, y });
    },
    [canvasRef, sendTouch],
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
        <canvas
          ref={canvasRef}
          onMouseDown={(e) => handleTouch("begin", e)}
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
          justifyContent: "flex-end",
          padding: "4px 8px",
          borderTop: "1px solid rgba(255,255,255,0.12)",
          color: fps > 0 ? "#4f4" : "#888",
          fontSize: 12,
          fontFamily: "monospace",
        }}
      >
        {fps} fps
      </div>
    </div>
  );
}
