import { expect, it } from "vitest";
import { normalizeVideoOfferSdp } from "../src/client/webrtc/video-codec";

it.each(["\r\n", "\n"])("removes orphan codec attributes within each offered video section (%j)", newline => {
  const lines = [
    "v=0", "a=x-session:keep",
    "m=video 9 UDP/TLS/RTP/SAVPF 120 124", "a=mid:0", "a=ice-ufrag:unchanged",
    "a=rtpmap:120 VP8/90000", "a=rtpmap:124 rtx/90000", "a=fmtp:124 apt=120",
    "a=rtcp-fb:120 nack", "a=rtcp-fb:* transport-cc", "a=x-video:keep",
    "a=fmtp:126 profile-level-id=42e01f", "a=rtcp-fb:126 nack pli",
    "m=video 9 UDP/TLS/RTP/SAVPF 126", "a=mid:1", "a=rtpmap:126 H264/90000",
    "a=fmtp:126 profile-level-id=42e01f;packetization-mode=1", "a=rtcp-fb:126 nack",
    "a=rtcp-fb:120 nack pli",
    "m=audio 9 UDP/TLS/RTP/SAVPF 0", "a=fmtp:0 keep-audio",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=sctp-port:5000", "",
  ];
  const omitted = new Set([11, 12, 18]);
  const expected = lines.filter((_line, index) => !omitted.has(index)).join(newline);
  expect(normalizeVideoOfferSdp(lines.join(newline))).toBe(expected);
  expect(normalizeVideoOfferSdp(expected)).toBe(expected);
});

it("preserves valid codec parameters, feedback and opaque data without reserializing SDP", () => {
  const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n" +
    "a=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e034;packetization-mode=1\r\n" +
    "a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtcp-fb:96 nack\r\n" +
    "a=rtcp-fb:* transport-cc\r\na=unknown:exact spacing  and values\r\n";
  expect(normalizeVideoOfferSdp(sdp)).toBe(sdp);
});
