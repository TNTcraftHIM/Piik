// Voice levels and the microphone gate's rules. The audio-thread worklet runs
// these rules, so this module imports nothing that a worklet bundle cannot carry.

/** A voice counts as speaking from this level, in dBFS. */
export const SPEAKING_LEVEL_DBFS = -40;

export const levelFromDbfs = (dbfs: number): number => 10 ** (dbfs / 20);
/** The linear level of `SPEAKING_LEVEL_DBFS`, comparable with RMS and WebRTC `audioLevel`. */
export const SPEAKING_LEVEL = levelFromDbfs(SPEAKING_LEVEL_DBFS);
