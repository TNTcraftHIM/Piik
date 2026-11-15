import { recordLinearCandidate } from "../lib/debug-webrtc";
import { candidateSignalOrigin } from "../../shared/nat-candidate";
import { debugError } from "../lib/debug";

export async function addRemoteIceCandidate(
  connection: RTCPeerConnection,
  candidate: RTCIceCandidateInit | null,
  origin?: "linear",
): Promise<void> {
  try {
    await connection.addIceCandidate(candidate);
    if (origin === "linear" && candidate) recordLinearCandidate(connection, candidate);
  } catch (error) {
    // A stale/rejected candidate is disposable input, not failed SDP or a dead
    // transport. Keep draining this generation; ICE state owns route failure.
    if (!(error instanceof DOMException && error.name === "OperationError")) {
      throw error;
    }
    debugError("webrtc", "remote-candidate-rejected", error, {
      origin: origin ?? candidateSignalOrigin(candidate?.candidate ?? null),
    });
  }
}
