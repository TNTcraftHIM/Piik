import { Btn } from "./primitives";

export function HostMicrophone({ enabled, pending, disabled, nativeCapture, onToggle }: {
  enabled: boolean; pending?: boolean; disabled?: boolean;
  nativeCapture?: boolean; onToggle: () => void;
}) {
  return <div className="lr-host-microphone">
    <Btn icon={enabled ? "microphone" : "microphoneOff"}
      cap="host.microphone.label"
      title={nativeCapture ? "host.microphone.browserOnly" : pending ? "host.microphone.pending"
        : enabled ? "host.microphone.mute" : "host.microphone.enable"}
      hint={enabled ? "hint-microphone-off" : "hint-microphone-on"}
      pressed={enabled} busy={pending} tone={enabled ? "on" : undefined}
      disabled={nativeCapture || pending || disabled} onClick={onToggle} />
  </div>;
}
