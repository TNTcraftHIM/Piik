import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import { AppQualityPreference } from "../src/client/native/quality-preference";
import { discoverNativeHealth } from "../src/client/native/client";
import { nativeHealthSchema, NATIVE_CLIENT_PROTOCOL, NATIVE_CLIENT_PORT_START } from "../src/client/native/wire";

vi.mock("../src/client/native/client", () => ({ discoverNativeHealth: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const health = nativeHealthSchema.parse({
  protocol: NATIVE_CLIENT_PROTOCOL, service: "piik-client", port: NATIVE_CLIENT_PORT_START,
  instanceToken: "a".repeat(43), qualityPreference: true,
});

describe("App quality preference transport", () => {
  it("leaves older Apps alone and does not discover after retirement", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    vi.mocked(discoverNativeHealth).mockResolvedValue({ ...health, qualityPreference: undefined });
    expect(await AppQualityPreference.connect(controller.signal)).toBeNull();
    controller.abort();
    expect(await AppQualityPreference.connect(controller.signal)).toBeNull();
    expect(discoverNativeHealth).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the advertised App instance and bounds writes to the latest applied choice", async () => {
    vi.mocked(discoverNativeHealth).mockResolvedValue(health);
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(DEFAULT_QUALITY_SETTINGS)))
      .mockReturnValueOnce(pending)
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const preference = (await AppQualityPreference.connect(controller.signal))!;
    expect(await preference.read()).toEqual(DEFAULT_QUALITY_SETTINGS);
    preference.save(DEFAULT_QUALITY_SETTINGS);
    preference.save({ ...DEFAULT_QUALITY_SETTINGS, maxBitrate: 4_000_000 });
    const latest = { ...DEFAULT_QUALITY_SETTINGS, maxBitrate: 5_000_000 };
    preference.save(latest);
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenLastCalledWith(`http://127.0.0.1:${health.port}/quality-preference`, expect.objectContaining({
      method: "PUT", body: JSON.stringify(latest), cache: "no-store",
      headers: expect.objectContaining({ "X-Piik-Instance": health.instanceToken }),
    }));
    controller.abort();
    preference.save(DEFAULT_QUALITY_SETTINGS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid replies and treats failed writes as optional", async () => {
    vi.mocked(discoverNativeHealth).mockResolvedValue(health);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const preference = (await AppQualityPreference.connect(new AbortController().signal))!;
    await expect(preference.read()).rejects.toThrow();
    preference.save(DEFAULT_QUALITY_SETTINGS);
    preference.save({ ...DEFAULT_QUALITY_SETTINGS, maxBitrate: 4_000_000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  });
});
