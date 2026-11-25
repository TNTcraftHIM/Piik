// Voice levels and the microphone gate's rules. The audio-thread worklet runs
// these rules, so this module imports nothing that a worklet bundle cannot carry.

/** When the shared voice microphone transmits. Mute overrides every mode. */
export const microphoneModes = ["open", "push", "activity"] as const;
export type MicrophoneMode = typeof microphoneModes[number];

/** The stored transmission choice. */
export interface VoiceTransmission {
  mode: MicrophoneMode;
  /** Voice activation transmits at or above this level, in dBFS. */
  activationThreshold: number;
}

/** A voice counts as speaking from this level, in dBFS; voice activation starts from it too. */
export const SPEAKING_LEVEL_DBFS = -40;
/** Voice activation's range, in dBFS: from a quiet room's noise floor to loud, close speech. */
export const VOICE_ACTIVATION_RANGE_DBFS = [-70, -10] as const;

export const levelFromDbfs = (dbfs: number): number => 10 ** (dbfs / 20);
export const dbfsFromLevel = (level: number): number => 20 * Math.log10(level);
/** The linear level of `SPEAKING_LEVEL_DBFS`, comparable with RMS and WebRTC `audioLevel`. */
export const SPEAKING_LEVEL = levelFromDbfs(SPEAKING_LEVEL_DBFS);

/** Push to talk keeps sending this long after release, so the last syllable is not cut. */
export const PUSH_TO_TALK_RELEASE_SECONDS = .2;
/** Voice activation stays open this long after the level last reached the threshold, across pauses between words. */
export const VOICE_ACTIVATION_HOLD_SECONDS = .3;
/** The gate fades over this time when it opens or closes, so it never clicks. */
export const VOICE_GATE_RAMP_SECONDS = .01;
export const VOICE_GATE_PROCESSOR = "piik-voice-gate";

/** What the page tells the gate. Open microphone has no gate. */
export interface VoiceGateSettings {
  mode: Exclude<MicrophoneMode, "open">;
  /** Linear RMS at or above which voice activation transmits. */
  threshold: number;
  /** The talk key is held. Only push to talk reads it. */
  pressed: boolean;
}

export interface VoiceGate extends VoiceGateSettings {
  /** Audio-context time, in seconds, until which the gate passes audio. */
  until: number;
}

export const closedVoiceGate: VoiceGate = { mode: "push", threshold: SPEAKING_LEVEL, pressed: false, until: -Infinity };

/** New settings apply from the next render quantum. A different mode starts closed instead of inheriting the old mode's hold. */
export function retuneVoiceGate(gate: VoiceGate, settings: VoiceGateSettings): VoiceGate {
  return { ...settings, until: settings.mode === gate.mode ? gate.until : -Infinity };
}

/**
 * When the gate closes, judged after a render quantum at audio-context time `now`
 * whose RMS is `level`. The gate passes audio while `now` is before this time.
 */
export function voiceGateUntil(gate: VoiceGate, level: number, now: number): number {
  if (gate.mode === "push") return gate.pressed ? now + PUSH_TO_TALK_RELEASE_SECONDS : gate.until;
  return level >= gate.threshold ? now + VOICE_ACTIVATION_HOLD_SECONDS : gate.until;
}
