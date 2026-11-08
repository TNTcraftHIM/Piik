import type { NativeSourceList } from '../components/living/CaptureSourcePicker';
import type { NativeCaptureTarget } from '../native/wire';
import type { loadCameraPreviews } from '../media/camera-previews';

export const POSTER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e8eee6"/><rect x="100" y="60" width="440" height="240" rx="20" fill="#fffdf6"/><path d="M100 100h440" stroke="#c9d7cf" stroke-width="2"/><circle cx="128" cy="81" r="6" fill="#ed9e65"/><circle cx="320" cy="190" r="46" fill="#65b099"/><path d="m310 191 9 9 16-22" fill="none" stroke="#fffdf6" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;
export const SOURCES = { kind: "ready", processAudio: true, systemAudio: true, processAudioExclusion: true, captureBorderControl: true, sources: [
  { kind: "window", sourceId: "101", pid: 1, creationTime: "1", title: "Sketchbook" },
  { kind: "window", sourceId: "102", pid: 2, creationTime: "2", title: "A short film" },
  { kind: "window", sourceId: "104", pid: 3, creationTime: "3", title: "Voice call" },
  { kind: "display", sourceId: "103", title: "Display 1" },
] } satisfies NativeSourceList;
export const CAMERA_PREVIEWS = [
  { id: "built-in", label: "Built-in camera", preview: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 320"><rect width="180" height="320" fill="#dce9e5"/><rect x="106" y="26" width="58" height="102" rx="7" fill="#fbfcf3"/><path d="M135 26v102M106 76h58" stroke="#b2cbc2" stroke-width="4"/><path d="M36 255q0-100 54-100t54 100" fill="#449986"/><circle cx="90" cy="124" r="29" fill="#449986"/><path d="M81 122v4m18-4v4" stroke="#203c3a" stroke-width="5" stroke-linecap="round"/><path d="M0 259h180v61H0" fill="#d8b898"/><rect x="142" y="241" width="21" height="23" rx="5" fill="#fff7e9"/></svg>')}` },
  { id: "usb", label: "USB Camera", preview: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#e2c5a8"/><path d="M0 25h320M0 157h320" stroke="#cda987" stroke-width="2"/><rect x="53" y="27" width="163" height="124" rx="5" fill="#fffaf0" transform="rotate(-8 135 89)"/><path d="m97 112 30-35 23 25 18-12 18 19" fill="none" stroke="#689b8a" stroke-width="5" stroke-linejoin="round"/><circle cx="166" cy="57" r="11" fill="#ebbd63"/><path d="m245 64 8 77" stroke="#477b73" stroke-width="7" stroke-linecap="round"/><circle cx="266" cy="35" r="19" fill="#f9f5df"/><circle cx="266" cy="35" r="12" fill="#8c6651"/></svg>')}` },
];
export const previewCameras: typeof loadCameraPreviews = async (_signal, publish) => publish(CAMERA_PREVIEWS);
export const previewSource = async (source: NativeCaptureTarget) => source.sourceId === "101" ? CAMERA_PREVIEWS[1].preview
  : source.sourceId === "102" ? CAMERA_PREVIEWS[0].preview : POSTER;
