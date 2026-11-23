import type { ChannelController } from "./types";
import type { VoiceShortcutAction } from "./voice-shortcut-binding";

export function resolveVoiceDockControls(channel: Pick<ChannelController,
  "state" | "sessionId" | "voiceMicrophonePending" | "canUnmute" | "setMuted" | "setDeafened">, selected: string) {
  const joined = channel.state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = joined.find(value => value.roomId === selected) ?? joined[0];
  const microphonePending = Boolean(activity?.muted && channel.voiceMicrophonePending(activity.roomId));
  const microphoneDisabled = Boolean(activity?.muted && !microphonePending && !channel.canUnmute(activity.roomId));
  const toggle = (action: VoiceShortcutAction): boolean => {
    if (!activity) return false;
    const { roomId, muted, deafened } = activity;
    if (action === "microphone" && microphoneDisabled) return false;
    const operation = action === "microphone" ? channel.setMuted(roomId, microphonePending || !muted) : channel.setDeafened(roomId, !deafened);
    void operation.catch(() => {});
    return true;
  };
  return { joined, activity, microphoneDisabled, microphonePending, toggle };
}
