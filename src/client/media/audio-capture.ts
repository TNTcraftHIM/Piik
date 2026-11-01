type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
};

type BrowserAudioConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean;
  restrictOwnAudio?: ConstrainBoolean;
};

export function audioInputConstraints(voiceProcessing: boolean): BrowserAudioConstraints {
  return {
    echoCancellation: voiceProcessing,
    noiseSuppression: voiceProcessing,
    autoGainControl: voiceProcessing,
    // Keep music/virtual inputs on the same unprocessed, stereo request as screen audio.
    ...(!voiceProcessing ? { voiceIsolation: false, channelCount: { ideal: 2 } } : {}),
  };
}

export function displayMediaOptions(
  video: MediaTrackConstraints,
): DisplayMediaStreamOptions {
  // Chromium web display capture otherwise defaults to speech processing.
  return {
    video,
    // Avoid recapturing this page's room voice where the Browser supports it.
    audio: { ...audioInputConstraints(false), restrictOwnAudio: true } as BrowserAudioConstraints,
    systemAudio: "include",
    windowAudio: "window",
  } as DisplayMediaAudioHints;
}
