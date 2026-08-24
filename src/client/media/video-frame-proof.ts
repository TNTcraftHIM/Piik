type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
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
    if (
      (baselineDecodedFrames !== null &&
        currentDecodedFrames !== null &&
        currentDecodedFrames > baselineDecodedFrames) ||
      video.currentTime > baselineCurrentTime
    ) {
      finish();
    }
  }

  function finish(): void {
    if (
      !active ||
      video.srcObject !== expectedStream ||
      video.readyState < 2
    ) {
      return;
    }
    active = false;
    removeFallbackListeners();
    onFrame();
  }

  if (target.requestVideoFrameCallback) {
    frameCallbackHandle = target.requestVideoFrameCallback(() => finish());
    return () => {
      active = false;
      if (frameCallbackHandle !== null) {
        target.cancelVideoFrameCallback?.(frameCallbackHandle);
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
