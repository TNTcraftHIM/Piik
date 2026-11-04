import { describe, expect, it, vi } from "vitest";
import { addRemoteIceCandidate } from "../src/client/webrtc/remote-ice-candidate.ts";

function candidate(port: number): RTCIceCandidateInit {
  return {
    candidate:
      `candidate:base 1 udp 2122260223 203.0.113.7 ${port} ` +
      "typ srflx raddr 192.0.2.7 rport 50000 generation 0 ufrag test",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "test",
  };
}

describe("remote ICE candidate adapter", () => {
  it("keeps unexpected ordinary-candidate failures visible", async () => {
    const error = new Error("candidate rejected");
    const connection = {
      addIceCandidate: vi.fn(async () => {
        throw error;
      }),
    } as unknown as RTCPeerConnection;
    await expect(addRemoteIceCandidate(connection, candidate(40_000))).rejects.toBe(error);
    await expect(addRemoteIceCandidate(connection, null)).rejects.toBe(error);
  });

  it("isolates candidate rejection without hiding a missing remote description", async () => {
    const connection = { addIceCandidate: vi.fn() } as unknown as RTCPeerConnection;
    vi.mocked(connection.addIceCandidate).mockRejectedValueOnce(new DOMException("Rejected", "OperationError"));
    await expect(addRemoteIceCandidate(connection, candidate(40_000))).resolves.toBeUndefined();
    const error = new DOMException("Remote description is missing", "InvalidStateError");
    vi.mocked(connection.addIceCandidate).mockRejectedValueOnce(error);
    await expect(addRemoteIceCandidate(connection, candidate(40_000))).rejects.toBe(error);
  });
});
