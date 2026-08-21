type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
};

type DisplayMediaAudioConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean;
};

export function displayMediaOptions(
  video: MediaTrackConstraints,
): DisplayMediaStreamOptions {
  // Chromium web display capture otherwise defaults to speech processing.
  const audio: DisplayMediaAudioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    channelCount: { ideal: 2 },
  };
  return {
    video,
    audio,
    systemAudio: "include",
    windowAudio: "window",
  } as DisplayMediaAudioHints;
}
