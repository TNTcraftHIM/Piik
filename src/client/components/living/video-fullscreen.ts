import { leavePictureInPicture } from "./use-picture-in-picture";

export type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
};

export function videoFullscreenState(video: FullscreenVideo) {
  const screen = video.parentElement;
  const pageSupported = Boolean(document.fullscreenEnabled && screen?.requestFullscreen);
  const nativeSupported = typeof video.webkitEnterFullscreen === "function";
  const nativeActive = Boolean(video.webkitDisplayingFullscreen || video.webkitPresentationMode === "fullscreen");
  return {
    supported: pageSupported || nativeSupported,
    ready: pageSupported || (nativeSupported && video.readyState >= 1 && video.webkitSupportsFullscreen === true),
    active: Boolean(screen && document.fullscreenElement === screen) || nativeActive,
    nativeActive,
  };
}

// Request in the original click stack: fullscreen consumes user activation.
// Native events, rather than a successful method call, confirm Safari entry.
export async function toggleVideoFullscreen(video: FullscreenVideo): Promise<void> {
  const screen = video.parentElement;
  const state = videoFullscreenState(video);
  if (screen && document.fullscreenElement === screen) {
    await document.exitFullscreen();
  } else if (state.nativeActive) {
    video.webkitExitFullscreen?.();
  } else if (state.ready) {
    if (document.fullscreenEnabled && screen?.requestFullscreen) {
      await screen.requestFullscreen();
      await leavePictureInPicture(video).catch(() => undefined);
    } else {
      video.webkitEnterFullscreen?.();
    }
  }
}
