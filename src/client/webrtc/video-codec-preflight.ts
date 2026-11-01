import { applyH264ProbeCodec, normalizeVideoOfferSdp, type BrowserVideoCodec } from "./video-codec";

/** Auto proves one actual encode; it does not rate or benchmark the source. */
export async function preferredVideoCodecForTrack(track: MediaStreamTrack, signal: AbortSignal): Promise<BrowserVideoCodec> {
  let sender: RTCPeerConnection | undefined, receiver: RTCPeerConnection | undefined, clone: MediaStreamTrack | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let stop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  // Every operation, including SDP, shares the same finite decision budget.
  const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stopped]);
  const abort = () => stop(new DOMException("Codec selection cancelled", "AbortError"));
  const deadline = setTimeout(() => stop(new Error("Codec probe timed out")), 4000);
  signal.addEventListener("abort", abort, { once: true });
  const gathered = (pc: RTCPeerConnection): Promise<void> => {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); };
    });
  };
  const live = () => track.readyState !== "ended";
  try {
    if (signal.aborted) throw new DOMException("Codec selection cancelled", "AbortError");
    if (track.kind !== "video" || !live()) return "vp8";
    clone = track.clone();
    sender = new RTCPeerConnection({ iceServers: [] });
    receiver = new RTCPeerConnection({ iceServers: [] });
    const transceiver = sender.addTransceiver(clone, { direction: "sendonly" });
    if (!applyH264ProbeCodec(transceiver)) return "vp8";
    await wait(sender.setLocalDescription(await wait(sender.createOffer())));
    await wait(gathered(sender));
    await wait(receiver.setRemoteDescription({ type: "offer", sdp: normalizeVideoOfferSdp(sender.localDescription!.sdp) }));
    await wait(receiver.setLocalDescription(await wait(receiver.createAnswer())));
    await wait(gathered(receiver));
    await wait(sender.setRemoteDescription(receiver.localDescription!));
    while (live()) {
      const stats = await wait(transceiver.sender.getStats());
      let encoded = false;
      stats.forEach(record => {
        const codec = stats.get(record.codecId);
        if (record.type === "outbound-rtp" && record.kind === "video" && record.framesEncoded > 0
            && codec?.mimeType?.toLowerCase() === "video/h264") encoded = true;
      });
      if (encoded) return "h264";
      await wait(new Promise<void>(resolve => { poll = setTimeout(resolve, 100); }));
    }
    return "vp8";
  } catch (error) {
    if (signal.aborted) throw error;
    return "vp8";
  } finally {
    clearTimeout(deadline); clearTimeout(poll);
    signal.removeEventListener("abort", abort);
    if (sender) sender.onicegatheringstatechange = null;
    if (receiver) receiver.onicegatheringstatechange = null;
    sender?.close(); receiver?.close(); clone?.stop();
  }
}
