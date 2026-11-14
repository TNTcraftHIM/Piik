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
  localSource = stream !== null,
) {
  const [suspended, setSuspended] = useState(false);
  const pausedByUser = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !localSource) return;
    // Native sound controls must not monitor a local capture, including one
    // watched from another page that does not own its sharing controls.
    const keepMuted = () => { video.muted = true; };
    keepMuted();
    video.addEventListener("volumechange", keepMuted);
    return () => video.removeEventListener("volumechange", keepMuted);
  }, [videoRef, localSource]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      pausedByUser.current = false;
      setSuspended(false);
      return;
    }
    const ownerDocument = video.ownerDocument;
    const view = ownerDocument.defaultView;
    if (!view) return;
    let policyPause = false;
    const syncPlayback = () => {
      const shouldPause = shouldPauseLocalPreview(ownerDocument.visibilityState, ownerDocument.hasFocus(), isPictureInPicture(video), autoPause);
      setSuspended(shouldPause);
      if (shouldPause || pausedByUser.current) {
        if (!video.paused) {
          policyPause = shouldPause;
          video.pause();
        }
      } else if (video.paused) void video.play().catch(() => undefined);
    };
    const paused = () => {
      if (!video.paused) return;
      if (policyPause) policyPause = false;
      else pausedByUser.current = true;
    };
    const played = () => {
      if (video.paused) return;
      policyPause = false;
      pausedByUser.current = false;
      syncPlayback();
    };
    video.addEventListener("pause", paused);
    video.addEventListener("play", played);
    ownerDocument.addEventListener("visibilitychange", syncPlayback);
    view.addEventListener("blur", syncPlayback);
    view.addEventListener("focus", syncPlayback);
    const pictureEvents = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"];
    pictureEvents.forEach(event => video.addEventListener(event, syncPlayback));
    syncPlayback();
    return () => {
      video.removeEventListener("pause", paused);
      video.removeEventListener("play", played);
      ownerDocument.removeEventListener("visibilitychange", syncPlayback);
      view.removeEventListener("blur", syncPlayback);
      view.removeEventListener("focus", syncPlayback);
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
