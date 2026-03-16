import { useCallback, type CSSProperties, type MouseEvent } from "react";
import { useWebRTC } from "./useWebRTC.js";

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
  const { videoRef, dataChannelRef, connected, error, screenSize } = useWebRTC({
    url,
  });

  const sendTouch = useCallback(
    (type: "begin" | "move" | "end", event: MouseEvent<HTMLVideoElement>) => {
      const dc = dataChannelRef.current;
      if (!dc || dc.readyState !== "open") return;

      const video = videoRef.current;
      if (!video) return;

      const rect = video.getBoundingClientRect();
      // Normalize coordinates to 0..1
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      dc.send(JSON.stringify({ type, x, y }));
    },
    [dataChannelRef, videoRef],
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
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onMouseDown={(e) => sendTouch("begin", e)}
        onMouseMove={(e) => {
          if (e.buttons > 0) sendTouch("move", e);
        }}
        onMouseUp={(e) => sendTouch("end", e)}
        onMouseLeave={(e) => {
          if (e.buttons > 0) sendTouch("end", e);
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
