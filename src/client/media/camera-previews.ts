import { browserCameras, type CaptureDevice } from "./capture-devices";

export type CameraPreview = CaptureDevice & { preview: string | null };

function frame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(320 / video.videoWidth, 320 / video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", .75);
}

async function snapshot(stream: MediaStream, signal: AbortSignal): Promise<string | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    return await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", finish);
        signal.removeEventListener("abort", finish);
        try { resolve(signal.aborted ? null : frame(video)); }
        catch { resolve(null); }
      };
      const timer = setTimeout(finish, 2000);
      video.addEventListener("loadeddata", finish);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
      else void video.play().catch(finish);
    });
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/** Picker-only snapshots. Never open another camera while a camera is shared. */
export async function loadCameraPreviews(signal: AbortSignal,
  publish: (sources: CameraPreview[]) => void, activeVideo?: HTMLVideoElement | null): Promise<void> {
  let owned: MediaStream | null = null;
  const release = () => { owned?.getTracks().forEach(track => track.stop()); owned = null; };
  const open = async (id: string) => {
    signal.throwIfAborted();
    owned = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: "environment" } }),
      width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15, max: 15 },
    } });
    // A permission promise can settle after the picker has closed.
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    return owned;
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    signal.throwIfAborted();
    let devices = await browserCameras();
    signal.throwIfAborted();
    if (activeVideo) {
      const stream = activeVideo.srcObject as MediaStream | null;
      const id = stream?.getVideoTracks()[0]?.getSettings().deviceId;
      publish(devices.map(device => ({ ...device, preview: device.id === id ? frame(activeVideo) : null })));
      return;
    }
    // Permission exposes device identities. Keep that first frame before retiring
    // the temporary input, then visit remaining cameras one at a time.
    let first: MediaStream | null = null;
    if (!devices.some(device => device.label)) {
      first = await open("");
      devices = await browserCameras();
      signal.throwIfAborted();
      const track = first.getVideoTracks()[0];
      if (!devices.length && track) devices = [{ id: track.getSettings().deviceId ?? "", label: track.label }];
    }
    const sources: CameraPreview[] = devices.map(device => ({ ...device, preview: null }));
    publish(sources.map(source => ({ ...source })));
    const firstId = first?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    if (first) {
      const source = sources.find(source => source.id === firstId);
      if (source) source.preview = await snapshot(first, signal);
      release();
    }
    for (const source of sources) {
      signal.throwIfAborted();
      if (!first || source.id !== firstId) {
        try { source.preview = await snapshot(await open(source.id), signal); }
        catch (error) { if (signal.aborted) throw error; /* A busy camera remains selectable. */ }
        finally { release(); }
      }
      if (!signal.aborted) publish(sources.map(source => ({ ...source })));
    }
  } finally {
    release();
    signal.removeEventListener("abort", release);
  }
}
