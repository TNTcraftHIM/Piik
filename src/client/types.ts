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
  frameWidth: number | null;
  frameHeight: number | null;
  resolution: string | null;
  packetsLost: number | null;
  intervalPacketsSent: number | null;
  intervalPacketsReceived: number | null;
  intervalPacketsLost: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  framesDropped: number | null;
  intervalFramesDecoded: number | null;
  intervalFramesDropped: number | null;
  intervalFreezeCount: number | null;
  intervalFreezeDurationMs: number | null;
  intervalRetransmittedPackets: number | null;
  intervalRetransmittedBytes: number | null;
  codec: string | null;
  codecProfile: string | null;
  codecParameters: string | null;
  audioBitrateKbps: number | null;
  audioPacketLossPercent: number | null;
  audioJitterMs: number | null;
  audioCodec: string | null;
  audioCodecClockRate: number | null;
  audioCodecChannels: number | null;
  audioCodecParameters: string | null;
  scalabilityMode: string | null;
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
  frameWidth: null,
  frameHeight: null,
  resolution: null,
  packetsLost: null,
  intervalPacketsSent: null,
  intervalPacketsReceived: null,
  intervalPacketsLost: null,
  packetLossPercent: null,
  jitterMs: null,
  framesDropped: null,
  intervalFramesDecoded: null,
  intervalFramesDropped: null,
  intervalFreezeCount: null,
  intervalFreezeDurationMs: null,
  intervalRetransmittedPackets: null,
  intervalRetransmittedBytes: null,
  codec: null,
  codecProfile: null,
  codecParameters: null,
  audioBitrateKbps: null,
  audioPacketLossPercent: null,
  audioJitterMs: null,
  audioCodec: null,
  audioCodecClockRate: null,
  audioCodecChannels: null,
  audioCodecParameters: null,
  scalabilityMode: null,
  encoderImplementation: null,
  powerEfficientEncoder: null,
  intervalEncodeMs: null,
  intervalDecodeMs: null,
  qualityLimitationReason: null,
};
