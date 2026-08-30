interface OptionalVideoFrameCallbacks {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  webkitDecodedFrameCount?: number;
};

export function isAutoplayPolicyRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

export function observeCompositedVideoFrame(
  video: HTMLVideoElement,
  expectedStream: MediaStream,
  onFrame: () => void,
): () => void {
  const target = video as VideoWithFrameCallback;
  const frameCallbacks = video as unknown as OptionalVideoFrameCallbacks;
  const requestVideoFrameCallback =
    frameCallbacks.requestVideoFrameCallback?.bind(video);
  let active = true;
  let frameCallbackHandle: number | null = null;
  const fallbackEvents = ["loadeddata", "timeupdate", "playing"] as const;
  const removeFallbackListeners = (): void => {
    for (const event of fallbackEvents) {
      video.removeEventListener(event, checkFallback);
    }
  };
  const baselineDecodedFrames = decodedFrameCount(target);
  const baselineCurrentTime = video.currentTime;

  function checkFallback(): void {
    if (
      !active ||
      video.srcObject !== expectedStream ||
      video.readyState < 2
    ) {
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
      active = false;
      removeFallbackListeners();
      return true;
    }
    if (video.readyState < 2) {
      return false;
    }
    active = false;
    removeFallbackListeners();
    onFrame();
    return true;
  }

  function requestNextFrame(): void {
    frameCallbackHandle =
      requestVideoFrameCallback?.(() => {
        frameCallbackHandle = null;
        if (!finish()) {
          requestNextFrame();
        }
      }) ?? null;
  }

  if (requestVideoFrameCallback) {
    requestNextFrame();
    return () => {
      active = false;
      if (frameCallbackHandle !== null) {
        frameCallbacks.cancelVideoFrameCallback?.call(
          video,
          frameCallbackHandle,
        );
      }
    };
  }

  for (const event of fallbackEvents) {
    video.addEventListener(event, checkFallback);
  }
  checkFallback();

  return () => {
    active = false;
    removeFallbackListeners();
  };
}

function decodedFrameCount(video: VideoWithFrameCallback): number | null {
  if (typeof video.getVideoPlaybackQuality === "function") {
    const count = video.getVideoPlaybackQuality().totalVideoFrames;
    return Number.isFinite(count) ? count : null;
  }
  return typeof video.webkitDecodedFrameCount === "number" &&
    Number.isFinite(video.webkitDecodedFrameCount)
    ? video.webkitDecodedFrameCount
    : null;
}
