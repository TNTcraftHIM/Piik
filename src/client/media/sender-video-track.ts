import { debugError } from "../lib/debug";

type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameAPIs = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
    readable: ReadableStream<VideoFrame>;
  };
  MediaStreamTrackGenerator?: new (options: { kind: "video" }) => FrameTrack;
};
const inputs = new WeakMap<MediaStreamTrack, { track: MediaStreamTrack; abort: AbortController }>();

/** The sender owns this track, including its optional display-capture input. */
export function cloneSenderVideoTrack(
  source: MediaStreamTrack,
  onEnded: (track: MediaStreamTrack) => void,
): MediaStreamTrack {
  const input = source.clone();
  input.contentHint = source.contentHint || "motion";
  input.enabled = source.enabled;
  const { MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator } = globalThis as typeof globalThis & FrameAPIs;
  if (!Processor || !Generator || !source.getSettings().displaySurface || input.readyState !== "live") return input;

  let output: FrameTrack | undefined;
  let readable: ReadableStream<VideoFrame> | undefined;
  try {
    output = new Generator({ kind: "video" });
    readable = new Processor({ track: input, maxBufferSize: 1 }).readable;
  } catch (error) {
    output?.stop();
    debugError("capture", "sender-frame-isolation-unavailable", error);
    return input;
  }
  // Chromium forwards an encoder's soft pixel target as a capture hard limit.
  // Forward frames without transforming them so sender adaptation cannot shrink
  // its own recovery input. No new encoder, frame clock or resolution policy.
  const abort = new AbortController();
  const track = output;
  const frames = readable;
  input.enabled = true;
  track.contentHint = input.contentHint;
  track.enabled = source.enabled;
  inputs.set(track, { track: input, abort });
  void applySenderCaptureConstraints(track, input.getConstraints())
    .then(() => frames.pipeTo(track.writable, { signal: abort.signal }))
    .catch((error) => {
      if (!abort.signal.aborted) debugError("capture", "sender-frame-isolation-failed", error);
    }).finally(() => {
      inputs.delete(track);
      // Also cancel when initial constraints failed before pipeTo acquired a reader.
      void frames.cancel().catch(() => undefined);
      input.stop();
      track.stop();
      if (!abort.signal.aborted) onEnded(track);
    });
  return track;
}

/** Capture settings belong to the input, before sender-owned adaptation. */
export function senderCaptureTrack(track: MediaStreamTrack): MediaStreamTrack {
  return inputs.get(track)?.track ?? track;
}

export function applySenderCaptureConstraints(track: MediaStreamTrack, constraints: MediaTrackConstraints): Promise<void> {
  const input = inputs.get(track)?.track;
  if (!input) return track.applyConstraints(constraints);
  const rate = constraints.frameRate;
  // A Processor does not request idle refresh frames as an RTC sender does.
  // Preserve the native display-capture refresh with a standard constraint;
  // this is not a sender FPS floor or an application-generated frame clock.
  return input.applyConstraints({ ...constraints, frameRate: {
    ...(typeof rate === "object" ? rate : { ideal: rate }), min: 1,
  } });
}

export function stopSenderVideoTrack(track: MediaStreamTrack | null): void {
  if (!track) return;
  const input = inputs.get(track);
  input?.abort.abort();
  input?.track.stop();
  track.stop();
}
