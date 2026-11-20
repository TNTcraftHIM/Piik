import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSiteEntry } from "../src/client/channel/components/ChannelSiteEntry";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => vi.unstubAllGlobals());

it("includes offline connection advice on a failed site entry", () => {
  setCopy({ lang: "en" });
  vi.stubGlobal("location", new URL("https://site.invalid"));
  const html = renderToStaticMarkup(createElement(ChannelSiteEntry, {
    channel: { connection: "closed", error: null, reconnect: vi.fn(), joinAsNewIdentity: vi.fn() },
    failure: { message: "Connection failed", connectionHelp: true },
  }));
  expect(html).toContain("<details");
  expect(html).toContain("another browser");
  expect(html).not.toContain("github.com/TNTcraftHIM/Piik/blob/main");
});
