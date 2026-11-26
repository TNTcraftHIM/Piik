import type { ChannelSnapshot } from "./protocol";
import type { ChannelController } from "./types";
import type { VoiceToggleAction } from "./voice-shortcut-binding";

type RoomVoiceChannel = Pick<ChannelController,
  "voiceMicrophonePending" | "canUnmute" | "setMuted" | "setDeafened">;

export function resolveVoiceDockControls(channel: Pick<ChannelController, "state" | "sessionId">, selected: string) {
  const joined = channel.state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = joined.find(value => value.roomId === selected) ?? joined[0];
  return { joined, activity };
}

export function resolveRoomVoiceControls(channel: RoomVoiceChannel, activity: ChannelSnapshot["voice"][number]) {
  const microphonePending = activity.muted && channel.voiceMicrophonePending(activity.roomId);
  const microphoneDisabled = activity.muted && !microphonePending && !channel.canUnmute(activity.roomId);
  const toggle = (action: VoiceToggleAction): boolean => {
    const { roomId, muted, deafened } = activity;
    if (action === "microphone" && microphoneDisabled) return false;
    const operation = action === "microphone" ? channel.setMuted(roomId, microphonePending || !muted) : channel.setDeafened(roomId, !deafened);
    void operation.catch(() => {});
    return true;
  };
  return { microphoneDisabled, microphonePending, toggle };
}
