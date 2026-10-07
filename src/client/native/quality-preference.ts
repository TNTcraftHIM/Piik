import { qualitySettingsSchema, type QualitySettings } from "../../shared/protocol";
import { debugError } from "../lib/debug";
import { discoverNativeHealth } from "./client";
import type { NativeHealth } from "./wire";

/** Optional App storage; never claims a media control session or delays sharing. */
export class AppQualityPreference {
  private pending: QualitySettings | null = null;
  private writing = false;

  private constructor(
    private readonly health: NativeHealth,
    private readonly signal: AbortSignal,
  ) {}

  static async connect(signal: AbortSignal): Promise<AppQualityPreference | null> {
    if (signal.aborted) return null;
    const health = await discoverNativeHealth();
    return health?.qualityPreference && !signal.aborted
      ? new AppQualityPreference(health, signal) : null;
  }

  async read(): Promise<QualitySettings | null> {
    const value: unknown = await (await this.request()).json();
    return value === null ? null : qualitySettingsSchema.parse(value);
  }

  save(settings: QualitySettings): void {
    if (this.signal.aborted) return;
    this.pending = settings;
    if (!this.writing) void this.flush();
  }

  private async flush(): Promise<void> {
    this.writing = true;
    try {
      // A slider can change during a write. Keep only its latest applied choice.
      while (this.pending && !this.signal.aborted) {
        const settings = this.pending;
        this.pending = null;
        try {
          await this.request(settings);
        } catch (error) {
          if (!this.signal.aborted) debugError("native", "quality-preference-save-failed", error);
        }
      }
    } finally {
      this.pending = null;
      this.writing = false;
    }
  }

  private async request(settings?: QualitySettings): Promise<Response> {
    const response = await fetch(`http://127.0.0.1:${this.health.port}/quality-preference`, {
      method: settings ? "PUT" : "GET",
      headers: { "Content-Type": "application/json", "X-Piik-Instance": this.health.instanceToken },
      ...(settings ? { body: JSON.stringify(settings) } : {}),
      cache: "no-store",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(4_000)]),
      targetAddressSpace: "loopback",
    } as RequestInit);
    if (!response.ok) throw new Error(`Piik App preference request failed (${response.status})`);
    return response;
  }
}
