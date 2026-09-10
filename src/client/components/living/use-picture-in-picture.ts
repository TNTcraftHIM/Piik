import { useEffect, useState, type RefObject } from "react";

type PictureVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};

export async function leavePictureInPicture(video: PictureVideo): Promise<void> {
  if (document.pictureInPictureElement === video) {
    await document.exitPictureInPicture();
  } else if (video.webkitPresentationMode === "picture-in-picture") {
    video.webkitSetPresentationMode?.("inline");
  }
}

// The browser owns the window and its lifecycle, including its close button.
export function usePictureInPicture(videoRef: RefObject<HTMLVideoElement | null>) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current as PictureVideo | null;
    if (!video) return;
    const sync = () => {
      setSupported(Boolean(
        (document.pictureInPictureEnabled && video.requestPictureInPicture) ||
        (video.webkitSetPresentationMode && video.webkitSupportsPresentationMode?.("picture-in-picture")),
      ));
      setActive(document.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture");
      setFailed(false);
    };
    const events = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "loadedmetadata", "emptied"];
    events.forEach((event) => video.addEventListener(event, sync));
    sync();
    return () => {
      events.forEach((event) => video.removeEventListener(event, sync));
      void leavePictureInPicture(video).catch(() => undefined);
    };
  }, [videoRef]);

  const toggle = async () => {
    const video = videoRef.current as PictureVideo | null;
    if (!video) return;
    setFailed(false);
    try {
      if (document.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture") {
        await leavePictureInPicture(video);
      } else {
        if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
          await video.requestPictureInPicture();
        } else if (video.webkitSupportsPresentationMode?.("picture-in-picture")) {
          video.webkitSetPresentationMode?.("picture-in-picture");
        }
        // Request first: entering needs the click's transient user activation.
        if (document.fullscreenElement === video.parentElement) await document.exitFullscreen();
      }
    } catch {
      // An OS/user-policy rejection affects this action, never media recovery.
      setFailed(true);
    }
  };

  return { supported, active, failed, toggle };
}
