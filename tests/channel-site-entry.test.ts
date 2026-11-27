import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSiteEntry } from "../src/client/channel/components/ChannelSiteEntry";
import { channelErrorPresentation } from "../src/client/components/error-presentation";
import { currentSiteResponds } from "../src/client/channel/site-health";
import { setCopy, t } from "../src/client/ui/copy";

afterEach(() => vi.unstubAllGlobals());

it("offers the site check and the matching 3.0 guide after a failed first connection", () => {
  setCopy({ lang: "en" });
  vi.stubGlobal("location", new URL("https://site.invalid"));
  const html = renderToStaticMarkup(createElement(ChannelSiteEntry, {
    channel: { connection: "reconnecting", error: null, reconnect: vi.fn(), joinAsNewIdentity: vi.fn() },
    failure: { message: "Connection failed", connectionHelp: true },
  }));
  expect(html).toContain("<details");
  expect(html).toContain("troubleshooting.md#the-page-opens-but-the-site-will-not-connect");
});

it.each(["connecting", "reconnecting"] as const)("shows the previous session timeout during %s", connection => {
  setCopy({ lang: "en" });
  vi.stubGlobal("location", new URL("https://site.invalid"));
  const error = "session_expired";
  const html = renderToStaticMarkup(createElement(ChannelSiteEntry, {
    channel: { connection, error, reconnect: vi.fn(), joinAsNewIdentity: vi.fn() },
    failure: channelErrorPresentation(error, (key, vars) => t("en", key, vars)),
  }));
  expect(html).toContain(`role="alert">${t("en", "channel.error.sessionExpired")}</p>`);
  expect(html).toContain(`role="status" class="visually-hidden">${t("en", "channel.siteEntry.connecting")}</span>`);
});

it("checks only the current origin and recognizes the Domain response", async () => {
  vi.stubGlobal("location", new URL("https://site.invalid/invitation?room=private#owner=private"));
  const request = vi.fn()
    .mockResolvedValueOnce(new Response("piik-channel-prototype"))
    .mockResolvedValueOnce(new Response("<html>Proxy page</html>"))
    .mockResolvedValueOnce(new Response("piik-channel-prototype", { status: 503 }))
    .mockRejectedValueOnce(new Error("unreachable"));
  vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  expect(await currentSiteResponds(signal)).toBe(true);
  expect(request).toHaveBeenCalledWith(new URL("https://site.invalid/healthz"), expect.objectContaining({
    mode: "same-origin", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  }));
  expect(await currentSiteResponds(signal)).toBe(false);
  expect(await currentSiteResponds(signal)).toBe(false);
  expect(await currentSiteResponds(signal)).toBe(false);
});

it("stops reading a response as soon as it differs from the site marker", async () => {
  vi.stubGlobal("location", new URL("https://site.invalid"));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("piik-channel-prototype-extra")); },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  expect(await currentSiteResponds(new AbortController().signal)).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});
