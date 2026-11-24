import { useEffect, useState, type RefObject } from "react";

const retainedPictures = new WeakSet<HTMLVideoElement>();

export function retainPictureInPicture(video: HTMLVideoElement): () => void {
  retainedPictures.add(video);
  return () => { retainedPictures.delete(video); };
}

type PictureVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};

export function isPictureInPicture(video: PictureVideo): boolean {
  return video.ownerDocument.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture";
}

export async function leavePictureInPicture(video: PictureVideo): Promise<void> {
  if (video.ownerDocument.pictureInPictureElement === video) {
    await video.ownerDocument.exitPictureInPicture();
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
        (video.ownerDocument.pictureInPictureEnabled && video.requestPictureInPicture) ||
        (video.webkitSetPresentationMode && video.webkitSupportsPresentationMode?.("picture-in-picture")),
      ));
      setActive(isPictureInPicture(video));
      setFailed(false);
    };
    const events = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "loadedmetadata", "emptied"];
    events.forEach((event) => video.addEventListener(event, sync));
    sync();
    return () => {
      events.forEach((event) => video.removeEventListener(event, sync));
      if (!retainedPictures.has(video)) void leavePictureInPicture(video).catch(() => undefined);
    };
  }, [videoRef]);

  const toggle = async () => {
    const video = videoRef.current as PictureVideo | null;
    if (!video) return;
    setFailed(false);
    try {
      if (isPictureInPicture(video)) {
        await leavePictureInPicture(video);
      } else {
        if (video.ownerDocument.pictureInPictureEnabled && video.requestPictureInPicture) {
          await video.requestPictureInPicture();
        } else if (video.webkitSupportsPresentationMode?.("picture-in-picture")) {
          video.webkitSetPresentationMode?.("picture-in-picture");
        }
        // Request first: entering needs the click's transient user activation.
        if (video.ownerDocument.fullscreenElement === video.parentElement) await video.ownerDocument.exitFullscreen();
      }
    } catch {
      // An OS/user-policy rejection affects this action, never media recovery.
      setFailed(true);
    }
  };

  return { supported, active, failed, toggle };
}
