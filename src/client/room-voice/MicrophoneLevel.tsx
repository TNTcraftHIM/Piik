import { useId } from "react";

// Same measured-input fill in the local toggle and participant microphone.
export function MicrophoneLevel({ level }: { level: number }) {
  const id = useId();
  const height = 11.6 * Math.min(1, Math.max(0, level) * 5);
  return <svg className="lr-voice-mic-level" viewBox="0 0 24 24" aria-hidden="true">
    <defs><clipPath id={id}><rect x="9.7" y="2.7" width="4.6" height="11.6" rx="2.3" /></clipPath></defs>
    <rect x="9.7" y={14.3 - height} width="4.6" height={height} clipPath={`url(#${id})`} />
  </svg>;
}
