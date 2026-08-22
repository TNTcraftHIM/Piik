const MAX_PAIR_GAP_MS = 450;

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const index = (values.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? values[lower]!
    : values[lower]! + (values[upper]! - values[lower]!) * (index - lower);
}

export function summarizeAvSyncMarkers(videoMarkersMs: readonly number[], audioMarkersMs: readonly number[]) {
  const audio = audioMarkersMs.filter(Number.isFinite).map(Number);
  const deltas: number[] = [];
  for (const video of videoMarkersMs.filter(Number.isFinite).map(Number)) {
    if (!audio.length) break;
    let nearest = 0;
    for (let index = 1; index < audio.length; index += 1) {
      if (Math.abs(audio[index]! - video) < Math.abs(audio[nearest]! - video)) nearest = index;
    }
    const delta = audio[nearest]! - video;
    if (Math.abs(delta) > MAX_PAIR_GAP_MS) continue;
    audio.splice(nearest, 1);
    deltas.push(delta);
  }
  const sorted = deltas.sort((a, b) => a - b);
  return {
    pairedEvents: sorted.length,
    medianDeltaMs: percentile(sorted, 0.5),
    p95DeltaMs: percentile(sorted, 0.95),
  };
}

export type AvSyncSummary = ReturnType<typeof summarizeAvSyncMarkers>;
