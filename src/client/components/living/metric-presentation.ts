import type { CopyKey } from "../../ui/copy";
import type { GlyphName } from "../../ui/icons";
import type { HintKind } from "../../ui/visual-kinds";

// The same metric keeps its icon and explanation in detail cells and headings.
export const METRIC_PRESENTATION = {
  "stats.resolution": { icon: "expand", hint: "hint-metric-resolution" },
  "stats.fps": { icon: "frames", hint: "hint-metric-fps" },
  "stats.bitrate": { icon: "gauge", hint: "hint-metric-bitrate" },
  "stats.loss": { icon: "packetLoss", hint: "hint-metric-loss" },
  "stats.rtt": { icon: "clock", hint: "hint-metric-rtt" },
  "stats.codec": { icon: "puzzle", hint: "hint-codec" },
  "stats.outgoing": { icon: "gauge", hint: "hint-metric-outgoing" },
  "stats.qualityState": { icon: "sliders", hint: "hint-metric-quality" },
  "stats.capture": { icon: "share", hint: "hint-metric-capture" },
  "stats.inputFps": { icon: "frames", hint: "hint-metric-input-fps" },
  "stats.encoder": { icon: "cpu", hint: "hint-metric-encoder" },
  "stats.encodeMs": { icon: "clock", hint: "hint-metric-encode-time" },
  "stats.jitter": { icon: "jitter", hint: "hint-metric-jitter" },
  "stats.dropped": { icon: "frameDrop", hint: "hint-metric-dropped" },
  "stats.decodeMs": { icon: "clock", hint: "hint-metric-decode-time" },
  "stats.freezeCount": { icon: "pause", hint: "hint-metric-freezes" },
  "stats.freezeDuration": { icon: "clock", hint: "hint-metric-freeze-time" },
  "stats.audio": { icon: "speaker", hint: "hint-metric-audio-bitrate" },
  "stats.audioLoss": { icon: "packetLoss", hint: "hint-metric-audio-loss" },
  "stats.audioJitter": { icon: "jitter", hint: "hint-metric-audio-jitter" },
  "stats.playoutDelta": { icon: "clock", hint: "hint-metric-playout" },
  "stats.videoBuffer": { icon: "clock", hint: "hint-metric-video-buffer" },
  "stats.audioBuffer": { icon: "clock", hint: "hint-metric-audio-buffer" },
  "stats.audioConcealedRate": { icon: "audioRepair", hint: "hint-metric-concealment-rate" },
  "stats.audioConcealed": { icon: "audioRepair", hint: "hint-metric-concealments" },
} satisfies Partial<Record<CopyKey, { icon: GlyphName; hint: HintKind }>>;

export type MetricLabel = keyof typeof METRIC_PRESENTATION;
