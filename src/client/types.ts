export type SignalConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export type MediaPath = "direct" | "relay" | "unknown";

export interface ConnectionMetrics {
  sampleTimestampMs: number | null;
  sampleWindowMs: number | null;
  rtpStatsId: string | null;
  rtpSsrc: number | null;
  rtpMid: string | null;
  trackIdentifier: string | null;
  selectedCandidatePairId: string | null;
  captureWidth: number | null;
  captureHeight: number | null;
  captureFramesPerSecond: number | null;
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
  intervalFramesDropped: number | null;
  intervalFreezeCount: number | null;
  intervalFreezeDurationMs: number | null;
  intervalRetransmittedPackets: number | null;
  intervalRetransmittedBytes: number | null;
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
  senderParameters?: import("./media/quality").VideoSenderParameterReadback | null;
  qualityWarning?: string | null;
}

export const EMPTY_METRICS: ConnectionMetrics = {
  sampleTimestampMs: null,
  sampleWindowMs: null,
  rtpStatsId: null,
  rtpSsrc: null,
  rtpMid: null,
  trackIdentifier: null,
  selectedCandidatePairId: null,
  captureWidth: null,
  captureHeight: null,
  captureFramesPerSecond: null,
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
  intervalFramesDropped: null,
  intervalFreezeCount: null,
  intervalFreezeDurationMs: null,
  intervalRetransmittedPackets: null,
  intervalRetransmittedBytes: null,
  codec: null,
  encoderImplementation: null,
  powerEfficientEncoder: null,
  intervalEncodeMs: null,
  intervalDecodeMs: null,
  qualityLimitationReason: null,
};
