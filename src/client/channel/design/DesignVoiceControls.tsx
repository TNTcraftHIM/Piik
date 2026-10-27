import { ChannelAction } from "../components/ChannelMedia";
import type { DesignCopy } from "./fixtures";

export interface DesignVoiceModel {
  joined: boolean;
  muted: boolean;
  deafened: boolean;
  toggleJoined(): void;
  toggleMuted(): void;
  toggleDeafened(): void;
}

export function DesignVoiceJoin({ voice, copy }: { voice: DesignVoiceModel; copy: DesignCopy }) {
  return <ChannelAction icon={voice.joined ? "door" : "headphones"} quiet iconOnly
    label={voice.joined ? copy("退出语音", "Leave voice") : copy("加入语音", "Join voice")}
    hint={voice.joined ? "hint-voice-leave" : "hint-voice-join"} onClick={voice.toggleJoined} />;
}

export function DesignVoiceControls({ voice, copy }: { voice: DesignVoiceModel; copy: DesignCopy }) {
  return <>
    <ChannelAction icon={voice.muted ? "microphoneOff" : "microphone"}
      label={voice.muted ? copy("开启麦克风", "Unmute microphone") : copy("关闭麦克风", "Mute microphone")}
      pressed={voice.muted} hint={voice.muted ? "hint-voice-microphone-on" : "hint-voice-microphone-off"}
      quiet iconOnly onClick={voice.toggleMuted} />
    <ChannelAction icon={voice.deafened ? "headphonesOff" : "headphones"}
      label={voice.deafened ? copy("开启收听", "Undeafen") : copy("关闭收听", "Deafen")}
      pressed={voice.deafened} hint={voice.deafened ? "hint-voice-undeafen" : "hint-voice-deafen"}
      quiet iconOnly onClick={voice.toggleDeafened} />
  </>;
}
