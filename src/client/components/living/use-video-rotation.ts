import { useLayoutEffect, type RefObject } from "react";
import { applyVideoRotation, type VideoFit, type VideoRotation } from "../../media/video-geometry";

export function useVideoRotation(videoRef: RefObject<HTMLVideoElement | null>, fit: VideoFit | undefined, rotation: VideoRotation): void {
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const refresh = () => applyVideoRotation(video, rotation);
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(video);
    video.addEventListener("resize", refresh);
    video.addEventListener("loadedmetadata", refresh);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", refresh);
      video.removeEventListener("loadedmetadata", refresh);
    };
  }, [videoRef, fit, rotation]);
}
