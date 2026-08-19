import { describe, expect, it, vi } from "vitest";

import { SfuStandbyPrewarmer } from "../src/client/media/sfu-standby-prewarmer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SfuStandbyPrewarmer", () => {
  it("does nothing when fallback is not advertised", () => {
    const load = vi.fn();
    const prewarmer = new SfuStandbyPrewarmer(load);

    prewarmer.setUrl(undefined);
    prewarmer.setUrl(null);

    expect(load).not.toHaveBeenCalled();
  });

  it("imports and warms each advertised URL at most once", async () => {
    const prepareConnection = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue({
      Room: class {
        prepareConnection = prepareConnection;
      },
    });
    const prewarmer = new SfuStandbyPrewarmer(load);

    prewarmer.setUrl("wss://sfu.example.test");
    prewarmer.setUrl("wss://sfu.example.test");
    await vi.waitFor(() => expect(prepareConnection).toHaveBeenCalledOnce());
    prewarmer.setUrl("wss://sfu.example.test");

    expect(load).toHaveBeenCalledOnce();
    expect(prepareConnection).toHaveBeenCalledWith(
      "wss://sfu.example.test",
    );
  });

  it("drops a stale authentication before the SDK import completes", async () => {
    const module = deferred<{
      Room: new () => { prepareConnection(url: string): Promise<void> };
    }>();
    const prepareConnection = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn(() => module.promise);
    const prewarmer = new SfuStandbyPrewarmer(load);

    prewarmer.setUrl("wss://stale.example.test");
    prewarmer.setUrl(null);
    module.resolve({
      Room: class {
        prepareConnection = prepareConnection;
      },
    });
    await module.promise;
    await Promise.resolve();

    expect(prepareConnection).not.toHaveBeenCalled();
  });

  it("keeps only the latest advertised URL across an import race", async () => {
    const module = deferred<{
      Room: new () => { prepareConnection(url: string): Promise<void> };
    }>();
    const prepareConnection = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn(() => module.promise);
    const prewarmer = new SfuStandbyPrewarmer(load);

    prewarmer.setUrl("wss://stale.example.test");
    prewarmer.setUrl("wss://current.example.test");
    module.resolve({
      Room: class {
        prepareConnection = prepareConnection;
      },
    });
    await vi.waitFor(() => expect(prepareConnection).toHaveBeenCalledOnce());

    expect(load).toHaveBeenCalledOnce();
    expect(prepareConnection).toHaveBeenCalledWith(
      "wss://current.example.test",
    );
  });

  it("silently falls back without retrying a failed warmup", async () => {
    const prepareConnection = vi.fn().mockRejectedValue(new Error("offline"));
    const prewarmer = new SfuStandbyPrewarmer(async () => ({
      Room: class {
        prepareConnection = prepareConnection;
      },
    }));

    prewarmer.setUrl("wss://sfu.example.test");
    await vi.waitFor(() => expect(prepareConnection).toHaveBeenCalledOnce());
    prewarmer.setUrl("wss://sfu.example.test");
    await Promise.resolve();

    expect(prepareConnection).toHaveBeenCalledOnce();
  });

  it("does not reschedule a failed SDK import for the same URL", async () => {
    const load = vi.fn().mockRejectedValue(new Error("chunk unavailable"));
    const prewarmer = new SfuStandbyPrewarmer(load);

    prewarmer.setUrl("wss://sfu.example.test");
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await Promise.resolve();
    prewarmer.setUrl("wss://sfu.example.test");

    expect(load).toHaveBeenCalledOnce();
  });
});
