type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
};

export function displayMediaOptions(
  video: MediaTrackConstraints,
): DisplayMediaStreamOptions {
  return {
    video,
    audio: true,
    systemAudio: "include",
    windowAudio: "window",
  } as DisplayMediaAudioHints;
}
