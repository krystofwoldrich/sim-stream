import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
  RTCRtpCodecParameters,
  type RTCDataChannel,
} from "werift";
import type { TouchEventPayload } from "./protocol.js";

const H264_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: 96,
  parameters:
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
});

const H264_CLOCK_RATE = 90000;
const MAX_RTP_PAYLOAD = 1200; // Safe MTU for RTP
const FU_A = 28;

interface PeerState {
  pc: RTCPeerConnection;
  track: MediaStreamTrack;
  dataChannel: RTCDataChannel | null;
  sequenceNumber: number;
  ssrc: number;
  payloadType: number;
}

export class WebRTCManager {
  private peers = new Map<string, PeerState>();
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private screenWidth = 1170;
  private screenHeight = 2532;
  private frameTimestamp = 0;
  private onTouch: ((touch: TouchEventPayload) => void) | null = null;

  setTouchHandler(handler: (touch: TouchEventPayload) => void): void {
    this.onTouch = handler;
  }

  setSPS(sps: Buffer): void {
    this.sps = sps;
  }

  setPPS(pps: Buffer): void {
    this.pps = pps;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  async handleOffer(sdp: string): Promise<{ sdp: string; peerId: string }> {
    const peerId = crypto.randomUUID();

    // Pass H.264 codec via constructor so werift can negotiate with the browser's offer
    const pc = new RTCPeerConnection({
      iceServers: [],
      codecs: {
        video: [H264_CODEC],
      },
      headerExtensions: { video: [], audio: [] },
    });

    const track = new MediaStreamTrack({ kind: "video" });

    const state: PeerState = {
      pc,
      track,
      dataChannel: null,
      sequenceNumber: 0,
      ssrc: Math.floor(Math.random() * 0xffffffff),
      payloadType: 96,
    };

    // Handle data channel from client
    pc.onDataChannel.subscribe((dc) => {
      console.log(`[webrtc] DataChannel opened: ${dc.label} (peer=${peerId})`);
      state.dataChannel = dc;

      dc.onMessage.subscribe((msg) => {
        try {
          const touch = JSON.parse(
            typeof msg === "string" ? msg : msg.toString(),
          ) as TouchEventPayload;
          this.onTouch?.(touch);
        } catch {
          // ignore malformed messages
        }
      });

      // Send screen size config
      dc.send(
        JSON.stringify({
          type: "config",
          width: this.screenWidth,
          height: this.screenHeight,
        }),
      );
    });

    pc.iceConnectionStateChange.subscribe(() => {
      console.log(
        `[webrtc] ICE state: ${pc.iceConnectionState} (peer=${peerId})`,
      );
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        this.removePeer(peerId);
      }
    });

    // Set remote description first — werift auto-creates transceivers from the offer
    await pc.setRemoteDescription({ type: "offer", sdp });

    // Find the video transceiver created from the offer and set it to sendonly
    const videoTransceiver = pc
      .getTransceivers()
      .find((t) => t.kind === "video");
    if (videoTransceiver) {
      videoTransceiver.setDirection("sendonly");
      videoTransceiver.sender.registerTrack(track);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Extract negotiated payload type from the sender's codec
    if (videoTransceiver?.sender.codec) {
      state.payloadType = videoTransceiver.sender.codec.payloadType;
      console.log(
        `[webrtc] Negotiated PT=${state.payloadType} for peer=${peerId}`,
      );
    }

    this.peers.set(peerId, state);

    console.log(`[webrtc] Peer connected: ${peerId}`);
    return { sdp: pc.localDescription!.sdp, peerId };
  }

  sendFrame(annexBData: Buffer, isKeyFrame: boolean): void {
    if (this.peers.size === 0) return;

    // Increment timestamp (90kHz clock, ~60fps = 1500 ticks per frame)
    this.frameTimestamp += 1500;

    // Parse Annex B NALUs (split by start codes)
    const nalus = parseAnnexB(annexBData);

    for (const [, state] of this.peers) {
      // If key frame and we have SPS/PPS, send them first
      if (isKeyFrame && this.sps && this.pps) {
        this.sendNALU(state, this.sps, false);
        this.sendNALU(state, this.pps, false);
      }

      for (let i = 0; i < nalus.length; i++) {
        const nalu = nalus[i]!;
        const isLast = i === nalus.length - 1;
        this.sendNALU(state, nalu, isLast);
      }
    }
  }

  private sendNALU(state: PeerState, nalu: Buffer, marker: boolean): void {
    if (nalu.length <= MAX_RTP_PAYLOAD) {
      // Single NAL unit packet
      this.sendRtpPacket(state, nalu, marker);
    } else {
      // Fragment with FU-A
      const naluHeader = nalu[0]!;
      const nri = naluHeader & 0x60;
      const naluType = naluHeader & 0x1f;

      let offset = 1; // skip NALU header
      let isFirst = true;

      while (offset < nalu.length) {
        const remaining = nalu.length - offset;
        const chunkSize = Math.min(remaining, MAX_RTP_PAYLOAD - 2); // 2 bytes for FU indicator + FU header
        const isLast = offset + chunkSize >= nalu.length;

        const fuIndicator = (nri & 0x60) | FU_A;
        let fuHeader = naluType;
        if (isFirst) fuHeader |= 0x80; // Start bit
        if (isLast) fuHeader |= 0x40; // End bit

        const payload = Buffer.alloc(2 + chunkSize);
        payload[0] = fuIndicator;
        payload[1] = fuHeader;
        nalu.copy(payload, 2, offset, offset + chunkSize);

        this.sendRtpPacket(state, payload, marker && isLast);

        offset += chunkSize;
        isFirst = false;
      }
    }
  }

  private sendRtpPacket(
    state: PeerState,
    payload: Buffer,
    marker: boolean,
  ): void {
    state.sequenceNumber = (state.sequenceNumber + 1) & 0xffff;

    const header = new RtpHeader();
    header.version = 2;
    header.padding = false;
    header.marker = marker;
    header.payloadType = state.payloadType;
    header.sequenceNumber = state.sequenceNumber;
    header.timestamp = this.frameTimestamp;
    header.ssrc = state.ssrc;

    const packet = new RtpPacket(header, payload);

    try {
      state.track.writeRtp(packet);
    } catch {
      // peer may have disconnected
    }
  }

  private removePeer(peerId: string): void {
    const state = this.peers.get(peerId);
    if (state) {
      state.pc.close();
      this.peers.delete(peerId);
      console.log(`[webrtc] Peer removed: ${peerId}`);
    }
  }

  stop(): void {
    for (const [id] of this.peers) {
      this.removePeer(id);
    }
  }
}

function parseAnnexB(data: Buffer): Buffer[] {
  const nalus: Buffer[] = [];
  let i = 0;

  while (i < data.length) {
    // Find start code (0x00 0x00 0x01 or 0x00 0x00 0x00 0x01)
    let startCodeLen = 0;
    if (
      i + 2 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1
    ) {
      startCodeLen = 3;
    } else if (
      i + 3 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      startCodeLen = 4;
    } else {
      i++;
      continue;
    }

    const naluStart = i + startCodeLen;
    i = naluStart;

    // Find next start code
    while (i < data.length) {
      if (
        i + 2 < data.length &&
        data[i] === 0 &&
        data[i + 1] === 0 &&
        (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
      ) {
        break;
      }
      i++;
    }

    if (naluStart < i) {
      nalus.push(data.subarray(naluStart, i));
    }
  }

  return nalus;
}
