type ViewerPlaybackElement = Pick<HTMLVideoElement, "srcObject" | "pause">;

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
