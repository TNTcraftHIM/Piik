import { useLayoutEffect, type RefObject } from "react";
import { applyVideoRotation, type VideoFit, type VideoRotation, type VideoSize } from "../../media/video-geometry";

export function useVideoRotation(videoRef: RefObject<HTMLVideoElement | null>, fit: VideoFit | undefined, rotation: VideoRotation, heldSize?: VideoSize): void {
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const refresh = () => applyVideoRotation(video, rotation, heldSize);
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(video);
    if (heldSize && video.parentElement) observer.observe(video.parentElement);
    video.addEventListener("resize", refresh);
    video.addEventListener("loadedmetadata", refresh);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", refresh);
      video.removeEventListener("loadedmetadata", refresh);
    };
  }, [videoRef, fit, rotation, heldSize]);
}
