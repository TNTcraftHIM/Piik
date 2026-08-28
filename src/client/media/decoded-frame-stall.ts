export const ROUTE_DECODED_FRAME_STALL_MS = 15_000;

export class DecodedFrameStallDetector {
  private identity: string | null = null;
  private lastDecodedAt = 0;
  private reported = false;
  private paused = false;

  setPaused(paused: boolean, nowMs = Date.now()): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.rebaseline(nowMs);
  }

  rebaseline(nowMs = Date.now()): void {
    this.lastDecodedAt = nowMs;
    this.reported = false;
  }

  allowReportRetry(): void {
    this.reported = false;
  }

  observe(
    identity: string,
    framesDecodedDelta: number | null,
    nowMs = Date.now(),
  ): boolean {
    if (identity !== this.identity) {
      this.identity = identity;
      this.lastDecodedAt = nowMs;
      this.reported = false;
      return false;
    }
    if (this.paused) {
      this.lastDecodedAt = nowMs;
      this.reported = false;
      return false;
    }
    if (framesDecodedDelta === null) {
      this.lastDecodedAt = nowMs;
      this.reported = false;
      return false;
    }
    if (framesDecodedDelta > 0) {
      this.lastDecodedAt = nowMs;
      this.reported = false;
      return false;
    }
    if (this.reported || nowMs - this.lastDecodedAt < ROUTE_DECODED_FRAME_STALL_MS) {
      return false;
    }
    this.reported = true;
    return true;
  }

  reset(): void {
    this.identity = null;
    this.lastDecodedAt = 0;
    this.reported = false;
  }
}
