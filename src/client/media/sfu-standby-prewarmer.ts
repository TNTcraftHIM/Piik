interface StandbyRoom {
  prepareConnection(url: string): Promise<void>;
}

interface LiveKitModule {
  Room: new () => StandbyRoom;
}

type LiveKitLoader = () => Promise<LiveKitModule>;

let sharedLiveKitModule: Promise<LiveKitModule> | null = null;

function loadLiveKit(): Promise<LiveKitModule> {
  sharedLiveKitModule ??= import("livekit-client");
  return sharedLiveKitModule;
}

export class SfuStandbyPrewarmer {
  private desiredUrl: string | null = null;
  private disposed = false;
  private module: Promise<LiveKitModule> | null = null;
  private readonly scheduledUrls = new Set<string>();
  private readonly attemptedUrls = new Set<string>();

  constructor(private readonly load: LiveKitLoader = loadLiveKit) {}

  setUrl(url: string | null | undefined): void {
    this.desiredUrl = url ?? null;
    if (
      this.disposed ||
      !url ||
      this.scheduledUrls.has(url) ||
      this.attemptedUrls.has(url)
    ) {
      return;
    }

    this.scheduledUrls.add(url);
    void this.prepare(url);
  }

  dispose(): void {
    this.disposed = true;
    this.desiredUrl = null;
  }

  private async prepare(url: string): Promise<void> {
    try {
      this.module ??= this.load();
      const { Room } = await this.module;
      if (this.disposed || this.desiredUrl !== url) {
        return;
      }
      this.attemptedUrls.add(url);
      await new Room().prepareConnection(url);
    } catch {
      if (!this.disposed && this.desiredUrl === url) {
        this.attemptedUrls.add(url);
      }
      // Standby warming is optional; the existing tokenized cold path remains.
    } finally {
      this.scheduledUrls.delete(url);
    }
  }
}
