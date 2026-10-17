// Match the Viewer's local object-fit when mapping input or magnifying its picture.
export function videoFitScale(video: HTMLVideoElement, width: number, height: number): number {
  const fit = video.style.objectFit === "cover" ? Math.max : Math.min;
  return fit(width / video.videoWidth, height / video.videoHeight);
}
