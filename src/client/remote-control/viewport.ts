import { pictureRect, rotatePicturePoint, videoBoxSize, videoPictureSize, videoRotation } from "../media/video-geometry";

type Point = { x: number; y: number };

// Local picture magnification only. The input owner still uses pictureRect's
// transformed video geometry; neither capture nor the remote desktop is resized.
export class RemoteViewport {
  scale = 1;
  private offset: Point = { x: 0, y: 0 };
  private room: { right: number; bottom: number } | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly surface: HTMLElement,
    private readonly changed: () => void,
  ) {}

  transform(from: Point, to: Point, ratio: number): void {
    const rect = this.surface.getBoundingClientRect();
    const next = Math.max(.5, Math.min(4, this.scale * ratio));
    const factor = next / this.scale;
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.offset = {
      x: to.x - center.x - (from.x - center.x - this.offset.x) * factor,
      y: to.y - center.y - (from.y - center.y - this.offset.y) * factor,
    };
    this.scale = next;
    this.refresh();
  }

  refresh(): void {
    const { videoWidth, videoHeight, style } = this.video;
    const { width, height } = this.surface.getBoundingClientRect();
    if (!videoWidth || !videoHeight || !width || !height) return;
    const picture = videoPictureSize(this.video, width, height);
    // Pan across the picture, adding only the visible tool's footprint at its
    // edges. Zooming out keeps the natural gutters; the picture remains reachable.
    const limit = (size: number, frame: number, room: number) => Math.max(0, Math.min((size + frame) / 2 - 1,
      Math.abs(size - frame) / 2 + Math.min(room, frame - 1)));
    const limitX = limit(picture.width * this.scale, width, this.room?.right ?? 0);
    const limitY = limit(picture.height * this.scale, height, this.room?.bottom ?? 0);
    const x = this.offset.x = Math.max(-limitX, Math.min(limitX, this.offset.x));
    const y = this.offset.y = Math.max(-limitY, Math.min(limitY, this.offset.y));
    style.transform = this.scale !== 1 || x !== 0 || y !== 0 ? `translate(${x}px, ${y}px) scale(${this.scale}) var(--picture-transform, rotate(0deg))` : "";
    // Clip to the original video cell, including when a keyboard occupies the
    // next grid cell. Inverse-transform its edges into the video's local space.
    const bounds = this.video.getBoundingClientRect(), surface = this.surface.getBoundingClientRect();
    const box = videoBoxSize(this.video);
    const corners = [[surface.left, surface.top], [surface.right, surface.bottom]].map(([x, y]) =>
      rotatePicturePoint({ x: (x - bounds.left) / bounds.width, y: (y - bounds.top) / bounds.height }, videoRotation(this.video), true));
    const insets = [Math.min(...corners.map(point => point.y)) * box.height,
      (1 - Math.max(...corners.map(point => point.x))) * box.width,
      (1 - Math.max(...corners.map(point => point.y))) * box.height,
      Math.min(...corners.map(point => point.x)) * box.width];
    style.clipPath = `inset(${insets.map(value => `${value}px`).join(" ")})`;
    this.changed();
  }

  follow(position: Point, room: { right: number; bottom: number } | null): void {
    const resized = this.room?.right !== room?.right || this.room?.bottom !== room?.bottom;
    this.room = room;
    if (!room) {
      if (resized) this.refresh();
      return;
    }
    const picture = pictureRect(this.video), rect = this.surface.getBoundingClientRect();
    if (!picture) return;
    const rotated = rotatePicturePoint(position, videoRotation(this.video));
    const x = picture.left + rotated.x * picture.width, y = picture.top + rotated.y * picture.height;
    const dx = Math.max(rect.left, Math.min(rect.right - Math.min(room.right, rect.width - 1), x)) - x;
    const dy = Math.max(rect.top, Math.min(rect.bottom - Math.min(room.bottom, rect.height - 1), y)) - y;
    if (!dx && !dy && !resized) return;
    this.offset.x += dx; this.offset.y += dy;
    this.refresh();
  }

  reset(): void {
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.room = null;
    this.video.style.transform = "";
    this.video.style.clipPath = "";
    this.changed();
  }
}
