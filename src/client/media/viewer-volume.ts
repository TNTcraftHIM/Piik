export interface ViewerVolumeState {
  volumePercent: number;
  muted: boolean;
  lastNonZeroVolumePercent: number;
}

interface ViewerVolumeTarget {
  volume: number;
  muted: boolean;
}

export const DEFAULT_VIEWER_VOLUME_STATE: ViewerVolumeState = {
  volumePercent: 100,
  muted: false,
  lastNonZeroVolumePercent: 100,
};

function normalizeVolumePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function setViewerVolume(
  current: ViewerVolumeState,
  requestedPercent: number,
): ViewerVolumeState {
  const volumePercent = normalizeVolumePercent(requestedPercent);
  if (volumePercent === 0) {
    return { ...current, volumePercent: 0, muted: true };
  }
  return {
    volumePercent,
    muted: false,
    lastNonZeroVolumePercent: volumePercent,
  };
}

export function toggleViewerMuted(
  current: ViewerVolumeState,
): ViewerVolumeState {
  if (!current.muted) {
    return { ...current, muted: true };
  }
  const volumePercent =
    current.volumePercent > 0
      ? current.volumePercent
      : Math.max(1, current.lastNonZeroVolumePercent);
  return {
    volumePercent,
    muted: false,
    lastNonZeroVolumePercent: volumePercent,
  };
}

export function applyViewerVolume(
  target: ViewerVolumeTarget,
  state: ViewerVolumeState,
): void {
  target.volume = state.volumePercent / 100;
  target.muted = state.muted;
}
