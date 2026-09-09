import { browserDebugEnabled, debugError, debugEvent } from "./debug";

const connections = new WeakMap<RTCPeerConnection, object>();
const statsTypes = new Set([
  "codec", "inbound-rtp", "outbound-rtp", "remote-inbound-rtp", "remote-outbound-rtp",
  "media-source", "transport", "candidate-pair", "local-candidate", "remote-candidate",
]);

// Observe existing connection owners and their existing statistics samples.
// These listeners add no polling or transport actions.
export function observeDebugConnection(connection: RTCPeerConnection, identity: object): void {
  if (!browserDebugEnabled) return;
  connections.set(connection, identity);
  const transports = new Set<RTCDtlsTransport>();
  const snapshot = (event: string) => {
    try {
      debugEvent("webrtc", event, { ...identity,
        connectionState: connection.connectionState, iceConnectionState: connection.iceConnectionState,
        iceGatheringState: connection.iceGatheringState, signalingState: connection.signalingState });
      for (const endpoint of [...connection.getSenders(), ...connection.getReceivers()]) {
        const transport = endpoint.transport;
        if (!transport || transports.has(transport)) continue;
        transports.add(transport);
        const state = () => debugEvent("webrtc", "dtls-state", { ...identity, state: transport.state });
        transport.addEventListener("statechange", state);
        state();
      }
    } catch (error) { debugError("webrtc", "collector-failed", error, { ...identity, collector: "connection-state" }); }
  };
  for (const event of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange", "signalingstatechange", "track"]) {
    connection.addEventListener(event, () => snapshot(event));
  }
  connection.addEventListener("icecandidateerror", (event) => {
    debugEvent("webrtc", "ice-candidate-error", { ...identity,
      errorCode: event.errorCode, errorText: event.errorText, address: event.address, port: event.port, url: event.url });
  });
  snapshot("created");
}

export function debugRtcStats(connection: RTCPeerConnection, report: RTCStatsReport): void {
  if (!browserDebugEnabled) return;
  const identity = connections.get(connection);
  if (!identity) return;
  const stats: object[] = [];
  report.forEach((record) => { if (statsTypes.has(record.type)) stats.push(record); });
  debugEvent("webrtc", "stats", { ...identity, stats });
}

export function debugRtcFailure(connection: RTCPeerConnection, error: unknown): void {
  if (browserDebugEnabled) debugError("webrtc", "collector-failed", error,
    { ...connections.get(connection), collector: "getStats" });
}

export function debugTrack(track: MediaStreamTrack, details: object = {}): void {
  if (!browserDebugEnabled) return;
  try {
    debugEvent("capture", "track", { ...details, trackId: track.id, kind: track.kind,
      state: track.readyState, enabled: track.enabled, muted: track.muted, contentHint: track.contentHint,
      settings: track.getSettings(), constraints: track.getConstraints() });
  } catch (error) { debugError("capture", "collector-failed", error, { collector: "track", trackId: track.id }); }
}
