import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { Btn } from "../../components/living/primitives";
import { VoiceListeningButton, VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";

export interface DesignVoiceModel {
  joined: boolean;
  muted: boolean;
  deafened: boolean;
  inputVolume: number;
  listeningVolume: number;
  toggleJoined(): void;
  toggleMuted(): void;
  toggleDeafened(): void;
  setInputVolume(volume: number): void;
  setListeningVolume(volume: number): void;
}

export function DesignVoiceJoin({ voice }: { voice: DesignVoiceModel }) {
  return <Btn icon={voice.joined ? "door" : "headphones"} quiet size="compact" draw="voice-membership"
    title={voice.joined ? "voice.leave" : "voice.join"} cap={voice.joined ? undefined : "voice.join"}
    hint={voice.joined ? "hint-voice-leave" : "hint-voice-join"} onClick={voice.toggleJoined} />;
}

export function DesignVoiceControls({ voice }: { voice: DesignVoiceModel }) {
  if (!voice.joined) return null;
  return <>
    <AudioVolumeMenu volume={voice.inputVolume} onVolume={voice.setInputVolume} label="host.microphone.volume" icon="microphone">
      <VoiceMicrophoneButton active={!voice.muted} onClick={voice.toggleMuted} />
    </AudioVolumeMenu>
    <AudioVolumeMenu volume={voice.listeningVolume} onVolume={voice.setListeningVolume} label="voice.listeningVolume" icon="headphones">
      <VoiceListeningButton deafened={voice.deafened} onClick={voice.toggleDeafened} />
    </AudioVolumeMenu>
  </>;
}
