import { afterEach, expect, it, vi } from "vitest";
import { normalizeVideoOfferSdp, requireReceivingVideo, VideoReceiveRejectedError } from "../src/client/webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../src/client/webrtc/video-codec-preflight";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["deadline", "cancel"] as const)("releases the probe clone and both PCs when setup never completes (%s)", async reason => {
  vi.useFakeTimers();
  const close = vi.fn(), stop = vi.fn();
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1" }] }) });
  vi.stubGlobal("RTCPeerConnection", class {
    close = close;
    addTransceiver() { return { setCodecPreferences() {}, sender: {} }; }
    createOffer() { return new Promise<RTCSessionDescriptionInit>(() => {}); }
  });
  const track = { kind: "video", readyState: "live", clone: () => ({ stop }) } as unknown as MediaStreamTrack;
  const abort = new AbortController();
  const selecting = preferredVideoCodecForTrack(track, abort.signal);
  const outcome = reason === "cancel" ? expect(selecting).rejects.toMatchObject({ name: "AbortError" }) : expect(selecting).resolves.toBe("vp8");
  if (reason === "cancel") abort.abort();
  else await vi.advanceTimersByTimeAsync(4000);
  await outcome;
  expect(close).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledOnce();
  expect(track.readyState).toBe("live");
  expect(vi.getTimerCount()).toBe(0);
});

it("recognizes a Browser-rejected video answer without inferring codec support", () => {
  const offer = (sdp: string): RTCSessionDescriptionInit => ({ type: "offer", sdp });
  const answer = (sdp: string): RTCSessionDescriptionInit => ({ type: "answer", sdp });
  const video = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 H264/90000\r\n";
  const rejected = "m=video 0 UDP/TLS/RTP/SAVPF 120\r\n";
  expect(() => requireReceivingVideo(offer(video), answer(rejected))).toThrow(VideoReceiveRejectedError);
  for (const [offered, accepted] of [
    [video, video.replace("sendonly", "recvonly")],
    [video + video, rejected + video.replace("sendonly", "recvonly")],
    [video.replace("9 UDP", "0 UDP"), rejected],
    [video.replace("sendonly", "inactive"), rejected],
    [video.replace("sendonly", "recvonly"), rejected],
    ["m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", "m=audio 0 UDP/TLS/RTP/SAVPF 111\r\n"],
  ]) expect(() => requireReceivingVideo(offer(offered!), answer(accepted!))).not.toThrow();
  expect(() => requireReceivingVideo(offer(video.replace("9 UDP", "0 UDP") + "a=bundle-only\r\n"),
    answer(rejected))).toThrow(VideoReceiveRejectedError);
});

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
