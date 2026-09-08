import { afterEach, describe, expect, it, vi } from "vitest";

function browser(search: string) {
  const page = Object.assign(new EventTarget(), {
    location: new URL(
      `https://private.example/r/1234${search}#v=private-grant`,
    ),
  }) as unknown as Window;
  vi.stubGlobal("window", page);
  return page;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("opt-in Browser diagnostics", () => {
  it("is quiet without the explicit page flag", async () => {
    const page = browser("");
    const logged = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const debug = await import("../src/client/lib/debug");
    expect(debug.installBrowserDebug()).toBeUndefined();
    debug.debugEvent("capture", "requested", { resolution: "1080p" });
    debug.debugError("capture", "failed", new Error("private detail"));
    expect(logged).not.toHaveBeenCalled();
    expect(page.__SCREENER_DEBUG__).toBeUndefined();
  });

  it("keeps a bounded detached snapshot and excludes unapproved data and raw errors", async () => {
    const page = browser("?debug=1&hostToken=private-token");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = await import("../src/client/lib/debug");
    const cleanup = debug.installBrowserDebug();
    const captureError = new DOMException(
      "candidate:1 1 UDP 1 192.0.2.1 1234 typ host",
      "NotReadableError",
    );
    debug.debugError("capture", "failed", captureError, {
      resolution: "1080p",
      maxFramerate: 30,
      ...{
        hostToken: "private-token",
        sdp: "private-sdp",
        candidate: "private-candidate",
        inviteUrl: "private-grant",
      },
    });
    const report = page.__SCREENER_DEBUG__!.export();
    expect(report).toContain("NotReadableError");
    for (const secret of [
      "private-token",
      "private-sdp",
      "private-candidate",
      "private-grant",
      "192.0.2.1",
      "private.example",
      "/r/1234",
    ])
      expect(report).not.toContain(secret);
    const forgedError = new Error("private-message");
    forgedError.name = "private-token";
    debug.debugError("capture", "failed", forgedError);
    expect(page.__SCREENER_DEBUG__!.events().at(-1)!.details.errorName).toBe(
      "Error",
    );
    for (let revision = 0; revision < 300; revision++)
      debug.debugEvent("signal", "route", { revision });
    const events = page.__SCREENER_DEBUG__!.events();
    expect(events).toHaveLength(256);
    expect(events[0]!.details.revision).toBe(44);
    events[0]!.details.revision = -1;
    expect(page.__SCREENER_DEBUG__!.events()[0]!.details.revision).toBe(44);
    debug.debugEvent("signal", "route", {
      state: "x".repeat(1000),
      revision: Number.NaN,
    });
    expect(page.__SCREENER_DEBUG__!.events().at(-1)!.details).toEqual({});
    page.__SCREENER_DEBUG__!.clear();
    expect(page.__SCREENER_DEBUG__!.events()).toEqual([]);
    cleanup?.();
    page.dispatchEvent(new Event("error"));
    expect(page.__SCREENER_DEBUG__!.events()).toEqual([]);
  });
});
