export type SignalConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export type MediaPath = "direct" | "unknown";

export interface ConnectionMetrics {
  sampleTimestampMs: number | null;
  sampleWindowMs: number | null;
  rtpStatsId: string | null;
  rtpSsrc: number | null;
  rtpMid: string | null;
  rtpRid: string | null;
  trackIdentifier: string | null;
  selectedCandidatePairId: string | null;
  captureWidth: number | null;
  captureHeight: number | null;
  captureFramesPerSecond: number | null;
  mediaSourceFramesPerSecond: number | null;
  path: MediaPath;
  iceProtocol: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  localCandidateAddress: string | null;
  localCandidatePort: number | null;
  remoteCandidateAddress: string | null;
  remoteCandidatePort: number | null;
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
  intervalPauseCount: number | null;
  intervalPauseDurationMs: number | null;
  intervalRetransmittedPackets: number | null;
  intervalRetransmittedBytes: number | null;
  codec: string | null;
  codecProfile: string | null;
  codecParameters: string | null;
  audioBitrateKbps: number | null;
  audioPacketLossPercent: number | null;
  audioJitterMs: number | null;
  audioVideoPlayoutDeltaMs: number | null;
  videoJitterBufferDelayMs: number | null;
  audioJitterBufferDelayMs: number | null;
  audioConcealedSamplesPercent: number | null;
  intervalAudioConcealmentEvents: number | null;
  audioCodec: string | null;
  audioCodecClockRate: number | null;
  audioCodecChannels: number | null;
  audioCodecParameters: string | null;
  scalabilityMode: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  intervalFramesEncoded: number | null;
  intervalEncodeTimeMs: number | null;
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
  audioSenderParameters?:
    | import("./media/quality").AudioSenderParameterReadback
    | null;
  qualityWarning?: string | null;
}

export const EMPTY_METRICS: ConnectionMetrics = {
  sampleTimestampMs: null,
  sampleWindowMs: null,
  rtpStatsId: null,
  rtpSsrc: null,
  rtpMid: null,
  rtpRid: null,
  trackIdentifier: null,
  selectedCandidatePairId: null,
  captureWidth: null,
  captureHeight: null,
  captureFramesPerSecond: null,
  mediaSourceFramesPerSecond: null,
  path: "unknown",
  iceProtocol: null,
  localCandidateType: null,
  remoteCandidateType: null,
  localCandidateAddress: null,
  localCandidatePort: null,
  remoteCandidateAddress: null,
  remoteCandidatePort: null,
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
  intervalPauseCount: null,
  intervalPauseDurationMs: null,
  intervalRetransmittedPackets: null,
  intervalRetransmittedBytes: null,
  codec: null,
  codecProfile: null,
  codecParameters: null,
  audioBitrateKbps: null,
  audioPacketLossPercent: null,
  audioJitterMs: null,
  audioVideoPlayoutDeltaMs: null,
  videoJitterBufferDelayMs: null,
  audioJitterBufferDelayMs: null,
  audioConcealedSamplesPercent: null,
  intervalAudioConcealmentEvents: null,
  audioCodec: null,
  audioCodecClockRate: null,
  audioCodecChannels: null,
  audioCodecParameters: null,
  scalabilityMode: null,
  encoderImplementation: null,
  powerEfficientEncoder: null,
  intervalFramesEncoded: null,
  intervalEncodeTimeMs: null,
  intervalEncodeMs: null,
  intervalDecodeMs: null,
  qualityLimitationReason: null,
};
