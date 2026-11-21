interface OptionalVideoFrameCallbacks {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  webkitDecodedFrameCount?: number;
};

export function observeCompositedVideoFrame(
  video: HTMLVideoElement,
  expectedStream: MediaStream | null,
  onFrame: () => void,
): () => void {
  const target = video as VideoWithFrameCallback;
  const frameCallbacks = video as unknown as OptionalVideoFrameCallbacks;
  const requestVideoFrameCallback =
    frameCallbacks.requestVideoFrameCallback?.bind(video);
  let active = true;
  let compositedFrameObserved = false;
  let frameCallbackHandle: number | null = null;
  const readyEvents = ["loadeddata", "seeked", "timeupdate", "playing"] as const;
  const removeReadyListeners = (): void => {
    for (const event of readyEvents) {
      video.removeEventListener(event, checkReady);
    }
  };
  const initialDecodedFrames = decodedFrameCount(target);
  const baselineDecodedFrames = expectedStream === null && initialDecodedFrames !== null ? 0 : initialDecodedFrames;
  const baselineCurrentTime = video.currentTime;

  function stop(): void {
    active = false;
    removeReadyListeners();
    if (frameCallbackHandle !== null) {
      frameCallbacks.cancelVideoFrameCallback?.call(video, frameCallbackHandle);
      frameCallbackHandle = null;
    }
  }

  function checkReady(): void {
    if (
      !active ||
      video.srcObject !== expectedStream ||
      video.readyState < 2
    ) {
      return;
    }
    if (requestVideoFrameCallback) {
      if (compositedFrameObserved) finish();
      return;
    }
    const currentDecodedFrames = decodedFrameCount(target);
    const decodedFrameAdvanced =
      baselineDecodedFrames !== null && currentDecodedFrames !== null
        ? currentDecodedFrames > baselineDecodedFrames
        : null;
    if (decodedFrameAdvanced ?? (video.currentTime > baselineCurrentTime)) {
      finish();
    }
  }

  function finish(): boolean {
    if (!active) {
      return true;
    }
    if (video.srcObject !== expectedStream) {
      stop();
      return true;
    }
    if (video.readyState < 2) {
      return false;
    }
    stop();
    onFrame();
    return true;
  }

  function requestNextFrame(): void {
    frameCallbackHandle =
      requestVideoFrameCallback?.(() => {
        frameCallbackHandle = null;
        // A paused seek can finish readiness after its final composited frame.
        compositedFrameObserved = true;
        if (!finish()) {
          requestNextFrame();
        }
      }) ?? null;
  }

  for (const event of readyEvents) {
    video.addEventListener(event, checkReady);
  }
  if (requestVideoFrameCallback) requestNextFrame();
  else checkReady();

  return stop;
}

function decodedFrameCount(video: VideoWithFrameCallback): number | null {
  if (typeof video.getVideoPlaybackQuality === "function") {
    const { totalVideoFrames, droppedVideoFrames } = video.getVideoPlaybackQuality();
    const count = totalVideoFrames - droppedVideoFrames;
    return Number.isFinite(count) ? count : null;
  }
  return typeof video.webkitDecodedFrameCount === "number" &&
    Number.isFinite(video.webkitDecodedFrameCount)
    ? video.webkitDecodedFrameCount
    : null;
}
