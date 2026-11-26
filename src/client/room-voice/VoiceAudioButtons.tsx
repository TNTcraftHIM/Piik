import type { ComponentProps } from "react";
import { Btn } from "../components/living/primitives";
import { MicrophoneLevel } from "./MicrophoneLevel";

type ButtonState = Pick<ComponentProps<typeof Btn>, "disabled" | "busy" | "quiet" | "className" | "hint" | "hintText" | "keyShortcuts" | "shortcutLabel" | "onClick">;

export function VoiceMicrophoneButton({ active, level, cancelPending, ...button }: ButtonState & { active: boolean; level?: number; cancelPending?: boolean }) {
  return <Btn {...button} icon={active ? "microphone" : "microphoneOff"}
    title={cancelPending ? "voice.cancelMicrophoneRequest" : "host.device.microphone"} textTooltip={cancelPending !== undefined}
    busy={cancelPending || button.busy} size="compact" draw="voice-microphone" pressed={cancelPending ? undefined : active}
    iconOverlay={active && !button.busy && level !== undefined && <MicrophoneLevel level={level} />} />;
}

export function VoiceListeningButton({ deafened, ...button }: ButtonState & { deafened: boolean }) {
  return <Btn {...button} icon={deafened ? "headphonesOff" : "headphones"} title="voice.listening"
    textTooltip={Boolean(button.shortcutLabel)} size="compact" draw="voice-listening" pressed={!deafened} />;
}
