import type { ChannelSnapshot } from "./protocol";
import type { ChannelController } from "./types";
import type { VoiceToggleAction } from "./voice-shortcut-binding";

type VoiceDockChannel = Pick<ChannelController,
  "state" | "sessionId" | "voiceMicrophonePending" | "canUnmute" | "setMuted" | "setDeafened">;

export function resolveVoiceDockControls(channel: VoiceDockChannel, selected: string | undefined) {
  const joined = channel.state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = selected === undefined ? undefined : joined.find(value => value.roomId === selected) ?? joined[0];
  return { joined, activity, ...resolveRoomVoiceControls(channel, activity) };
}

export function resolveRoomVoiceControls(channel: VoiceDockChannel, activity: ChannelSnapshot["voice"][number] | undefined) {
  const microphonePending = Boolean(activity?.muted && channel.voiceMicrophonePending(activity.roomId));
  const microphoneDisabled = Boolean(activity?.muted && !microphonePending && !channel.canUnmute(activity.roomId));
  const toggle = (action: VoiceToggleAction): boolean => {
    if (!activity) return false;
    const { roomId, muted, deafened } = activity;
    if (action === "microphone" && microphoneDisabled) return false;
    const operation = action === "microphone" ? channel.setMuted(roomId, microphonePending || !muted) : channel.setDeafened(roomId, !deafened);
    void operation.catch(() => {});
    return true;
  };
  return { microphoneDisabled, microphonePending, toggle };
}
