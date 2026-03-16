import { useCallback, useEffect, useRef, useState } from "react";

export interface UseWebRTCOptions {
  url: string;
}

export interface UseWebRTCResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dataChannelRef: React.RefObject<RTCDataChannel | null>;
  connected: boolean;
  error: string | null;
  screenSize: { width: number; height: number } | null;
}

export function useWebRTC({ url }: UseWebRTCOptions): UseWebRTCResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenSize, setScreenSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const connect = useCallback(async () => {
    try {
      const pc = new RTCPeerConnection({
        iceServers: [],
      });
      pcRef.current = pc;

      // Create data channel for touch events
      const dc = pc.createDataChannel("touch", { ordered: true });
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log("[webrtc] DataChannel open");
      };

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            width?: number;
            height?: number;
          };
          if (msg.type === "config" && msg.width && msg.height) {
            setScreenSize({ width: msg.width, height: msg.height });
          }
        } catch {
          // ignore
        }
      };

      // Handle incoming video track
      pc.ontrack = (event) => {
        console.log("[webrtc] Received track:", event.track.kind);
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
        } else if (videoRef.current) {
          const stream = new MediaStream([event.track]);
          videoRef.current.srcObject = stream;
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("[webrtc] ICE state:", pc.iceConnectionState);
        if (pc.iceConnectionState === "connected") {
          setConnected(true);
        } else if (
          pc.iceConnectionState === "disconnected" ||
          pc.iceConnectionState === "failed"
        ) {
          setConnected(false);
        }
      };

      // Add transceiver for receiving video
      pc.addTransceiver("video", { direction: "recvonly" });

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
          return;
        }
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
        // Timeout fallback
        setTimeout(resolve, 2000);
      });

      // Send offer to server
      const response = await fetch(`${url}/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const answer = (await response.json()) as { sdp: string };
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

      // Also fetch screen config
      try {
        const configResp = await fetch(`${url}/config`);
        if (configResp.ok) {
          const config = (await configResp.json()) as {
            width: number;
            height: number;
          };
          setScreenSize(config);
        }
      } catch {
        // config endpoint optional
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[webrtc] Connection error:", message);
      setError(message);
    }
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [connect]);

  return { videoRef, dataChannelRef, connected, error, screenSize };
}
