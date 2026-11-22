import type { ChannelController } from "./types";
import type { VoiceShortcutAction } from "./voice-shortcut-binding";

export function resolveVoiceDockControls(channel: ChannelController, selected: string) {
  const joined = channel.state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = joined.find(value => value.roomId === selected) ?? joined[0];
  const microphoneDisabled = Boolean(activity?.muted && !channel.canUnmute(activity.roomId));
  const toggle = (action: VoiceShortcutAction): boolean => {
    if (!activity) return false;
    const { roomId, muted, deafened } = activity;
    if (action === "microphone" && muted && !channel.canUnmute(roomId)) return false;
    const operation = action === "microphone" ? channel.setMuted(roomId, !muted) : channel.setDeafened(roomId, !deafened);
    void operation.catch(() => {});
    return true;
  };
  return { joined, activity, microphoneDisabled, toggle };
}
