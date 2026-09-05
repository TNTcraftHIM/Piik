import { expect, it } from "vitest";
import { offerHasNativeVideoCodec } from "../src/client/native/native-viewer-peer";

it("admits one active sending H264 or VP8 video section, not unrelated SDP codec text", () => {
  const video = (codec: string, direction = "sendonly", port = 9, payload = 96) => [
    `m=video ${port} UDP/TLS/RTP/SAVPF ${payload}`,
    `a=${direction}`,
    `a=rtpmap:96 ${codec}/90000`,
    "",
  ].join("\r\n");
  expect(offerHasNativeVideoCodec(video("H264"))).toBe(true);
  expect(offerHasNativeVideoCodec(video("VP8"))).toBe(true);
  expect(offerHasNativeVideoCodec(video("VP8", "sendrecv"))).toBe(true);
  for (const offer of [
    video("VP8", "recvonly"), video("VP8", "inactive"),
    video("VP8", "sendonly", 0), video("VP8", "sendonly", 9, 97),
    video("VP9"), video("H264") + video("VP8"),
    "m=audio 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n",
  ]) expect(offerHasNativeVideoCodec(offer)).toBe(false);
});
