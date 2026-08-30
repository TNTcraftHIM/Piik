type ViewerPlaybackElement = Pick<HTMLVideoElement, "srcObject" | "pause">;

export function prepareViewerPlayback(
  video: ViewerPlaybackElement,
  stream: MediaStream,
  paused: boolean,
): boolean {
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  if (paused) {
    video.pause();
    return false;
  }
  return true;
}
