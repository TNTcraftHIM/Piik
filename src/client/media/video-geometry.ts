export type VideoFit = "contain" | "cover" | "fill";

// Playback, remote input and magnification share the rendered picture dimensions.
export function videoPictureSize(video: HTMLVideoElement, width: number, height: number): { width: number; height: number } {
  if (video.style.objectFit === "fill") return { width, height };
  const fit = video.style.objectFit === "cover" ? Math.max : Math.min;
  const scale = fit(width / video.videoWidth, height / video.videoHeight);
  return { width: video.videoWidth * scale, height: video.videoHeight * scale };
}
