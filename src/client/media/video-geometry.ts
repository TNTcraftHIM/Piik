export type VideoFit = "contain" | "cover" | "fill";
export type VideoRotation = 0 | 90 | 180 | 270;
export type PicturePoint = { x: number; y: number };

export function videoBoxSize(video: HTMLVideoElement): { width: number; height: number } {
  const style = getComputedStyle(video);
  // clientWidth/clientHeight round fractional grid cells, which shifts input
  // and distorts fit after a quarter-turn.
  return { width: parseFloat(style.width), height: parseFloat(style.height) };
}

export function videoRotation(video: HTMLVideoElement): VideoRotation {
  return Number(video.dataset.pictureRotation ?? 0) as VideoRotation;
}

// Rotation is clockwise in screen coordinates. Points and motion share the
// same axes, but motion has no translation around the picture's center.
export function rotatePicturePoint(point: PicturePoint, rotation: VideoRotation, inverse = false): PicturePoint {
  const delta = rotatePictureDelta({ x: point.x - .5, y: point.y - .5 }, rotation, inverse);
  return { x: delta.x + .5, y: delta.y + .5 };
}

export function rotatePictureDelta(point: PicturePoint, rotation: VideoRotation, inverse = false): PicturePoint {
  const turn = inverse ? (360 - rotation) % 360 : rotation;
  if (turn === 90) return { x: -point.y, y: point.x };
  if (turn === 180) return { x: -point.x, y: -point.y };
  if (turn === 270) return { x: point.y, y: -point.x };
  return point;
}

// Playback, remote input and magnification share the rendered picture dimensions.
export function videoPictureSize(video: HTMLVideoElement, width: number, height: number, rotation = videoRotation(video)): { width: number; height: number } {
  if (video.style.objectFit === "fill") return { width, height };
  const sourceWidth = video.videoWidth || 16, sourceHeight = video.videoHeight || 9;
  const sideways = rotation === 90 || rotation === 270;
  const pictureWidth = sideways ? sourceHeight : sourceWidth, pictureHeight = sideways ? sourceWidth : sourceHeight;
  const fit = video.style.objectFit === "cover" ? Math.max : Math.min;
  const scale = fit(width / pictureWidth, height / pictureHeight);
  return { width: pictureWidth * scale, height: pictureHeight * scale };
}

// Keep the existing video cell and parent (fullscreen and overlays own them).
// Its fitted picture rotates into that cell; zoom composes this same transform.
export function applyVideoRotation(video: HTMLVideoElement, rotation: VideoRotation): void {
  video.dataset.pictureRotation = String(rotation);
  const { width, height } = videoBoxSize(video);
  if (!width || !height) return;
  const original = videoPictureSize(video, width, height, 0);
  const picture = videoPictureSize(video, width, height, rotation);
  const sideways = rotation === 90 || rotation === 270;
  const scaleX = (sideways ? picture.height : picture.width) / original.width;
  const scaleY = (sideways ? picture.width : picture.height) / original.height;
  video.style.setProperty("--picture-transform", `rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`);
}

export function pictureRect(video: HTMLVideoElement): { left: number; top: number; width: number; height: number } | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const { width, height } = videoPictureSize(video, rect.width, rect.height);
  if (!width || !height) return null;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

export function picturePoint(video: HTMLVideoElement, clientX: number, clientY: number): PicturePoint | null {
  const rect = pictureRect(video);
  if (!rect) return null;
  const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? rotatePicturePoint({ x, y }, videoRotation(video), true) : null;
}
