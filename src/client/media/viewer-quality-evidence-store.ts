import {
  nextViewerQualityEvidencePresentationExpiryAt,
  refreshViewerQualityEvidencePresentation,
  retainPresentViewerQualityEvidence,
  type ViewerQualityEvidencePresentation,
} from "./viewer-quality-evidence";

// Owns received presentations and their expiry together. Callers still validate
// route/peer authority and choose when to render the immutable snapshot.
export class ViewerQualityEvidenceStore {
  private values = new Map<string, ViewerQualityEvidencePresentation>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (
      values: ReadonlyMap<string, ViewerQualityEvidencePresentation>,
    ) => void,
  ) {}

  getSnapshot(): ReadonlyMap<string, ViewerQualityEvidencePresentation> {
    return this.values;
  }

  set(peerId: string, presentation: ViewerQualityEvidencePresentation | null): void {
    this.cancelExpiry(peerId);
    const changed = (this.values.get(peerId) ?? null) !== presentation;
    if (changed) {
      this.values = new Map(this.values);
      if (presentation === null) this.values.delete(peerId);
      else this.values.set(peerId, presentation);
    }
    if (presentation !== null) {
      const nowMs = Date.now();
      const expiryAt = nextViewerQualityEvidencePresentationExpiryAt(presentation, nowMs);
      if (expiryAt !== null) {
        this.timers.set(peerId, setTimeout(() => {
          if (this.values.get(peerId) !== presentation) return;
          this.set(peerId, refreshViewerQualityEvidencePresentation(presentation));
        }, Math.max(0, expiryAt - nowMs)));
      }
    }
    if (changed) this.onChange(this.values);
  }

  retain(presentPeerIds: ReadonlySet<string>): void {
    const retained = retainPresentViewerQualityEvidence(this.values, presentPeerIds);
    if (retained === this.values) return;
    for (const peerId of this.values.keys()) {
      if (!retained.has(peerId)) this.cancelExpiry(peerId);
    }
    this.values = retained;
    this.onChange(this.values);
  }

  clear(): void {
    this.retain(new Set());
  }

  private cancelExpiry(peerId: string): void {
    const timer = this.timers.get(peerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(peerId);
  }
}
