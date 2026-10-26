import type { CaptureDevice } from "./capture-devices";

// Both paths must support routing: room voice starts on a media element and
// uses Web Audio when the listener adjusts its gain.
export interface OutputAudioContext extends AudioContext { setSinkId(deviceId: string): Promise<void> }

export function audioOutputSelectionSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function"
    && typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as OutputAudioContext).setSinkId === "function"
    && typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices;
}

export async function browserAudioOutputs(): Promise<CaptureDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default")
    .map(device => ({ id: device.deviceId, label: device.label }));
}

// Firefox offers a dedicated permission picker. Other supporting browsers
// expose output devices after microphone permission; this explicit action
// releases that temporary input immediately and never publishes it to the room.
export async function requestAudioOutputAccess(): Promise<string | undefined> {
  const devices = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: () => Promise<MediaDeviceInfo>;
  };
  if (devices.selectAudioOutput) return (await devices.selectAudioOutput()).deviceId;
  const stream = await devices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => track.stop());
}
