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
        position: "relative",
        display: "inline-block",
        ...style,
      }}
      className={className}
    >
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
          height: "100%",
          objectFit: "contain",
          aspectRatio,
          cursor: "pointer",
          background: "#000",
          borderRadius: 12,
        }}
      />
      {connected && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "2px 8px",
            background: "rgba(0,0,0,0.6)",
            color: fps > 0 ? "#4f4" : "#888",
            fontSize: 12,
            fontFamily: "monospace",
            borderRadius: 6,
            pointerEvents: "none",
          }}
        >
          {fps} fps
        </div>
      )}
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
            borderRadius: 12,
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
            borderRadius: 12,
            padding: 20,
            textAlign: "center",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
