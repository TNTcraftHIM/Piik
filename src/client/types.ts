export type SignalConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export type MediaPath = "direct" | "relay" | "unknown";

export interface ConnectionMetrics {
  path: MediaPath;
  iceProtocol: string | null;
  localRelayProtocol: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  rttMs: number | null;
  bitrateKbps: number | null;
  availableOutgoingKbps: number | null;
  framesPerSecond: number | null;
  resolution: string | null;
  packetsLost: number | null;
  jitterMs: number | null;
  framesDropped: number | null;
  codec: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  intervalEncodeMs: number | null;
  intervalDecodeMs: number | null;
  qualityLimitationReason: string | null;
}

export interface PeerSnapshot {
  peerId: string;
  connectionId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  metrics: ConnectionMetrics;
  error: string | null;
}

export const EMPTY_METRICS: ConnectionMetrics = {
  path: "unknown",
  iceProtocol: null,
  localRelayProtocol: null,
  localCandidateType: null,
  remoteCandidateType: null,
  rttMs: null,
  bitrateKbps: null,
  availableOutgoingKbps: null,
  framesPerSecond: null,
  resolution: null,
  packetsLost: null,
  jitterMs: null,
  framesDropped: null,
  codec: null,
  encoderImplementation: null,
  powerEfficientEncoder: null,
  intervalEncodeMs: null,
  intervalDecodeMs: null,
  qualityLimitationReason: null,
};
