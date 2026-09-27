type ViewerPlaybackElement = Pick<HTMLVideoElement, "srcObject" | "pause">;

export function playbackFailure(error: unknown): "autoplay-blocked" | "playback-failed" | null {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  // pause()/load() cancel pending play promises; cancellation is not failed media.
  if (name === "AbortError") return null;
  return name === "NotAllowedError" ? "autoplay-blocked" : "playback-failed";
}

export interface RemoteMediaBinding {
  stream: MediaStream;
  generation: number;
  boundAtRevision: number;
  videoTrackKey: string;
  audioTrackKey: string;
}

// Audio can arrive after a proved video frame. It updates the audio consumer,
// not the picture's generation, frame proof or local playback intent.
export function nextViewerMediaBinding(
  current: RemoteMediaBinding | null,
  stream: MediaStream,
  revision: number,
  nextGeneration: number,
): RemoteMediaBinding {
  const videoTrackKey = stream.getVideoTracks().map(track => track.id).sort().join(":");
  const audioTrackKey = stream.getAudioTracks().map(track => track.id).sort().join(":");
  if (current?.stream === stream && current.videoTrackKey === videoTrackKey) {
    return current.audioTrackKey === audioTrackKey ? current : { ...current, audioTrackKey };
  }
  return { stream, generation: nextGeneration, boundAtRevision: revision, videoTrackKey, audioTrackKey };
}

export function prepareViewerPlayback(
  video: ViewerPlaybackElement,
  stream: MediaStream,
  paused: boolean,
  hostPause: { active: boolean; resume: boolean },
): boolean {
  // A new picture must resume with the Host, not inherit the old local pause.
  hostPause.active = paused;
  hostPause.resume = paused;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  if (paused) {
    video.pause();
    return false;
  }
  return true;
}
