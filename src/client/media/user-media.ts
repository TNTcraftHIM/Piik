// Raw Browser capture lifetime, shared with an optional platform media service.
const pending = { audio: 0, video: 0 };
const tracks = new Map<MediaStreamTrack, () => void>();
let port: MessagePort | undefined;

function publish(synchronized = false): void {
  port?.postMessage(JSON.stringify({ type: "media-state",
    microphone: pending.audio > 0 || [...tracks.keys()].some(track => track.kind === "audio"),
    camera: pending.video > 0 || [...tracks.keys()].some(track => track.kind === "video"),
    ...(synchronized ? { synchronized: true } : {}),
  }));
}

/** Install before rendering capture controls; ordinary Browsers need no port. */
export function installUserMediaPort(): void {
  window.addEventListener("message", event => {
    if ((event.source !== null && event.source !== window) || event.data !== "piik-browser-media" || !event.ports[0]) return;
    port?.close();
    const current = port = event.ports[0];
    // Permission grants can race earlier intent messages across WebView IPC.
    // The native request keeps its service until this fresh snapshot arrives.
    current.onmessage = event => {
      if (port === current && event.data === "media-sync") publish(true);
    };
    publish();
  });
}

export async function acquireUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const audio = !!constraints.audio, video = !!constraints.video;
  if (audio) pending.audio++;
  if (video) pending.video++;
  publish();
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    for (const track of stream.getTracks()) {
      if (track.readyState !== "live" || tracks.has(track)) continue;
      const ended = () => {
        track.removeEventListener("ended", ended);
        tracks.delete(track);
        publish();
      };
      tracks.set(track, ended);
      track.addEventListener("ended", ended);
    }
    return stream;
  } finally {
    if (audio) pending.audio--;
    if (video) pending.video--;
    publish();
  }
}

/** stop() does not dispatch ended; the existing release owner retires both. */
export function stopUserMediaTrack(track: MediaStreamTrack): void {
  track.stop();
  tracks.get(track)?.();
}
