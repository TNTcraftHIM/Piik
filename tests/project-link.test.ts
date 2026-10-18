import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

it.each(["available", "http-error", "unreachable", "timeout"])(
  "keeps the optional website probe shared and bounded: %s", async outcome => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
      if (outcome === "unreachable") throw new TypeError("Failed to fetch");
      if (outcome === "timeout") return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
      return new Response(null, { status: outcome === "available" ? 200 : 503 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { projectWebsiteAvailable } = await import("../src/client/lib/use-project-link");
    const first = projectWebsiteAvailable();
    expect(projectWebsiteAvailable()).toBe(first);
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toBe(outcome === "available");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: "HEAD", credentials: "omit", referrerPolicy: "no-referrer",
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);
