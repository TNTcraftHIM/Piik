import type { ReactNode } from "react";

export type ComicKind =
  | "waiting-for-host"
  | "connecting-p2p"
  | "connecting-sfu"
  | "signal-connecting"
  | "signal-recovering"
  | "signal-offline"
  | "signal-connected"
  | "signal-failed"
  | "media-playing"
  | "media-ready"
  | "share-live"
  | "share-ended"
  | "room-closed"
  | "room-code-invalid"
  | "page-refresh"
  | "site-access"
  | "source-switching"
  | "source-starting"
  | "preview-paused"
  | "update-available"
  | "debug-start"
  | "debug-export-failed"
  | "copy-failed"
  | "source-failed"
  | "settings-failed"
  | "name-invalid"
  | "transport-connected"
  | "tap-to-play"
  | "host-paused"
  | "recovering"
  | "route-failed"
  | "playback-failed"
  | "host-offline"
  | "no-audio"
  | "room-not-found"
  | "access-denied"
  | "invalid-invite"
  | "room-full"
  | "bandwidth-limited"
  | "encoder-limited"
  | "warning";

export type Set1Kind =
  | "hint-share-start"
  | "hint-share-stop"
  | "hint-pause"
  | "hint-resume"
  | "hint-switch-source"
  | "hint-reconnect"
  | "hint-capture-browser"
  | "hint-capture-camera"
  | "hint-microphone-on"
  | "hint-microphone-off"
  | "hint-microphone-volume"
  | "hint-capture-window"
  | "hint-capture-display";

export type Set2Kind =
  | "hint-copy-code"
  | "hint-shuffle-code"
  | "hint-copy-invite"
  | "hint-invite-link"
  | "hint-client-link"
  | "hint-rotate-invite"
  | "hint-revoke-invite"
  | "hint-password";

export type Set3Kind =
  | "hint-quality"
  | "hint-audio-quality"
  | "hint-degrade-pref"
  | "hint-prefer-resolution"
  | "hint-prefer-framerate"
  | "hint-codec"
  | "hint-advanced"
  | "hint-details"
  | "hint-debug-export"
  | "hint-more-metrics";

export type AdmissionHintKind =
  | "hint-policy-private"
  | "hint-admission-code"
  | "hint-admission-password"
  | "hint-admission-invite";

export type Set4Kind =
  | "hint-topology"
  | "hint-close"
  | "hint-rename"
  | "hint-theme-light"
  | "hint-theme-dark"
  | "hint-join-go"
  | "hint-theater"
  | "hint-theater-exit"
  | "hint-route-p2p"
  | "hint-route-p2p-required"
  | "hint-route-sfu"
  | "hint-nat-prediction"
  | "hint-nat-unavailable"
  | "hint-client-local"
  | "hint-client-site";

export type PlaybackHintKind =
  | "hint-local-play"
  | "hint-local-pause"
  | "hint-volume"
  | "hint-volume-basic"
  | "hint-mute"
  | "hint-unmute"
  | "hint-no-audio"
  | "hint-fullscreen"
  | "hint-fullscreen-exit"
  | "hint-fullscreen-unavailable"
  | "hint-pip"
  | "hint-pip-exit"
  | "hint-pip-unavailable";

export type ControlHintKind =
  | "hint-collapse"
  | "hint-refresh-sources"
  | "hint-source-picker"
  | "hint-no-sources"
  | "hint-show-capture-border"
  | "hint-hide-capture-border"
  | "hint-password-show"
  | "hint-password-hide"
  | "hint-password-remove"
  | "hint-source-audio"
  | "hint-share-audio"
  | "hint-stop-audio"
  | "hint-share-audio-fixed"
  | "hint-silent-share-fixed";

export type MetricHintKind = `hint-metric-${
  | "resolution" | "fps" | "bitrate" | "loss" | "rtt" | "outgoing"
  | "quality" | "capture" | "input-fps" | "encoder" | "encode-time"
  | "jitter" | "dropped" | "decode-time" | "freezes" | "freeze-time"
  | "audio-bitrate" | "audio-loss" | "audio-jitter" | "playout"
  | "video-buffer" | "audio-buffer" | "concealment-rate" | "concealments"
}`;

export type HintKind =
  | Set1Kind
  | Set2Kind
  | Set3Kind
  | Set4Kind
  | AdmissionHintKind
  | PlaybackHintKind
  | MetricHintKind
  | ControlHintKind;

export type ComicTheme = "stage" | "paper";
export type HintScene = (props: { theme: ComicTheme }) => ReactNode;
