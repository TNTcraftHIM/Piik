import { useEffect, useRef, useState, type RefObject } from "react";
import { isPictureInPicture } from "./use-picture-in-picture";

export function shouldPauseLocalPreview(
  visibilityState: DocumentVisibilityState,
  hasFocus: boolean,
  pictureInPicture = false,
  autoPause = true,
): boolean {
  return autoPause && !pictureInPicture && (visibilityState !== "visible" || !hasFocus);
}

// Local playback only; capture and sender quality retain their own lifetimes.
export function useHostPreviewPlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  stream: MediaStream | null,
  autoPause: boolean,
) {
  const [suspended, setSuspended] = useState(false);
  const pausedByUser = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      pausedByUser.current = false;
      setSuspended(false);
      return;
    }
    const syncPlayback = () => {
      const shouldPause = shouldPauseLocalPreview(document.visibilityState, document.hasFocus(), isPictureInPicture(video), autoPause);
      setSuspended(shouldPause);
      if (shouldPause) video.pause();
      else if (!pausedByUser.current) void video.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", syncPlayback);
    window.addEventListener("blur", syncPlayback);
    window.addEventListener("focus", syncPlayback);
    const pictureEvents = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"];
    pictureEvents.forEach(event => video.addEventListener(event, syncPlayback));
    syncPlayback();
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      window.removeEventListener("blur", syncPlayback);
      window.removeEventListener("focus", syncPlayback);
      pictureEvents.forEach(event => video.removeEventListener(event, syncPlayback));
    };
  }, [videoRef, stream, autoPause]);

  return {
    suspended,
    onPlay: () => {
      pausedByUser.current = false;
      void videoRef.current?.play().catch(() => undefined);
    },
    onPause: () => { pausedByUser.current = true; },
  };
}
