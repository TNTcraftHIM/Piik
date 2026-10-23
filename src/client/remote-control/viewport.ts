import { pictureRect, rotatePicturePoint, videoBoxSize, videoPictureSize, videoRotation } from "../media/video-geometry";

type Point = { x: number; y: number };

// Local picture magnification only. The input owner still uses pictureRect's
// transformed video geometry; neither capture nor the remote desktop is resized.
export class RemoteViewport {
  scale = 1;
  private offset: Point = { x: 0, y: 0 };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly surface: HTMLElement,
    private readonly changed: () => void,
  ) {}

  transform(from: Point, to: Point, ratio: number): void {
    const rect = this.surface.getBoundingClientRect();
    const next = Math.max(1, Math.min(4, this.scale * ratio));
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
    const limitX = Math.max(0, (picture.width * this.scale - width) / 2);
    const limitY = Math.max(0, (picture.height * this.scale - height) / 2);
    const x = this.offset.x = Math.max(-limitX, Math.min(limitX, this.offset.x));
    const y = this.offset.y = Math.max(-limitY, Math.min(limitY, this.offset.y));
    style.transform = this.scale > 1 ? `translate(${x}px, ${y}px) scale(${this.scale}) var(--picture-transform)` : "";
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

  visiblePosition(position: Point): Point {
    const picture = pictureRect(this.video), rect = this.surface.getBoundingClientRect();
    if (!picture) return position;
    // Keep the local touch cursor in view while panning. No remote input is
    // emitted until the user next moves or clicks, at this visible position.
    const rotated = rotatePicturePoint(position, videoRotation(this.video));
    return rotatePicturePoint({
      x: Math.max(0, Math.min(1, Math.max((rect.left - picture.left) / picture.width,
        Math.min((rect.right - picture.left) / picture.width, rotated.x)))),
      y: Math.max(0, Math.min(1, Math.max((rect.top - picture.top) / picture.height,
        Math.min((rect.bottom - picture.top) / picture.height, rotated.y)))),
    }, videoRotation(this.video), true);
  }

  reset(): void {
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.video.style.transform = "";
    this.video.style.clipPath = "";
    this.changed();
  }
}
