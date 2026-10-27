import type { ComponentProps } from "react";
import { Btn } from "../components/living/primitives";
import { MicrophoneLevel } from "./MicrophoneLevel";

type ButtonState = Pick<ComponentProps<typeof Btn>, "disabled" | "busy" | "quiet" | "hint" | "hintText" | "onClick">;

export function VoiceMicrophoneButton({ active, level, ...button }: ButtonState & { active: boolean; level?: number }) {
  return <Btn {...button} icon={active ? "microphone" : "microphoneOff"} title="host.device.microphone"
    size="compact" draw="voice-microphone" pressed={active}
    iconOverlay={active && !button.busy && level !== undefined && <MicrophoneLevel level={level} />} />;
}

export function VoiceListeningButton({ deafened, ...button }: ButtonState & { deafened: boolean }) {
  return <Btn {...button} icon={deafened ? "headphonesOff" : "headphones"} title="voice.listening"
    size="compact" draw="voice-listening" pressed={!deafened} />;
}
