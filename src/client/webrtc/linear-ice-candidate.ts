import { parse } from "sdp-transform";

/** One physical pair has one finite opportunity; ordinary ICE stays unfiltered. */
export class LinearCandidateAdmission {
  private readonly deadline = performance.now() + 5000;
  private readonly tuples = new Set<string>();
  admit(connection: RTCPeerConnection, candidate: RTCIceCandidateInit): boolean {
    if (performance.now() >= this.deadline || ["connected", "failed", "closed"].includes(connection.connectionState)
      || ["connected", "completed", "failed", "closed"].includes(connection.iceConnectionState)) return false;
    const tuple = linearCandidateTuple(candidate);
    if (!tuple || !currentCandidateGeneration(connection, candidate)) return false;
    if (this.tuples.has(tuple)) return false;
    if (this.tuples.size >= 16) return false;
    this.tuples.add(tuple); // A rejected API attempt still spent this target opportunity.
    return true;
  }
}

export function linearCandidateTuple(candidate: RTCIceCandidateInit): string | null {
  if (!candidate.candidate?.trim() || !candidate.usernameFragment?.trim()) return null;
  try {
    const parsed = parse("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=" + candidate.candidate + "\r\n").media[0]?.candidates?.[0];
    if (!parsed || parsed.transport.toLowerCase() !== "udp" || parsed.component !== 1 || parsed.type !== "srflx"
      || parsed.port < 1024 || parsed.port > 65535 || !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.ip)) return null;
    return JSON.stringify([parsed.transport.toLowerCase(), parsed.ip, parsed.port]);
  } catch { return null; }
}

export function currentCandidateGeneration(connection: RTCPeerConnection, candidate: RTCIceCandidateInit): boolean {
  if (!connection.remoteDescription?.sdp || !candidate.usernameFragment) return false;
  try {
    const session = parse(connection.remoteDescription.sdp);
    const media = candidate.sdpMid != null ? session.media.find(media => String(media.mid) === candidate.sdpMid)
      : candidate.sdpMLineIndex != null ? session.media[candidate.sdpMLineIndex] : undefined;
    if (!media) return false;
    const bundle = session.groups?.find(group => group.type === "BUNDLE" && String(group.mids).split(" ").includes(String(media.mid)));
    const tag = bundle && session.media.find(section => String(section.mid) === String(bundle.mids).split(" ")[0]);
    const fragment = media.iceUfrag ?? session.iceUfrag ?? (tag ? tag.iceUfrag : undefined);
    return candidate.usernameFragment === fragment;
  } catch { return false; }
}
