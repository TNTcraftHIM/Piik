export type CaptureDevice = { id: string; label: string };

// Enumeration never requests permission or opens a device. Device IDs remain
// local; the capture owner applies an explicit choice when permission is given.
export async function browserCaptureDevices(kind: "audioinput" | "videoinput"): Promise<CaptureDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications")
    .map(device => ({ id: device.deviceId, label: device.label }));
}

export const browserCameras = () => browserCaptureDevices("videoinput");
