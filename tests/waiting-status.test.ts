import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageOverlay } from "../src/client/components/living/Stage";
import { LoadingStatus } from "../src/client/components/living/WaitingStatus";
import { WelcomeCipher, WelcomeLine } from "../src/client/components/living/WelcomeLine";
import { locales } from "../src/client/locales";
import { setCopy, t } from "../src/client/ui/copy";

afterEach(() => {
  setCopy({ lang: "zh", vis: false });
  vi.restoreAllMocks();
});

it.each(["zh", "en"] as const)("keeps %s waiting copy secondary to the actual operation", lang => {
  setCopy({ lang, vis: false });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "client.launch.starting" }));
  expect(html).toContain(`aria-label="${t(lang, "client.launch.starting")}"`);
  expect(html).toContain('class="lr-waiting-caption" aria-hidden="true"');
  expect(html).toContain(locales[lang].playful.waiting[0]);
});

it.each(["host-paused", "preview-paused", "route-failed", "source-failed", "room-closed", "tap-to-play"] as const)(
  "keeps %s free of waiting decorations", comic => {
    const html = renderToStaticMarkup(createElement(StageOverlay, {
      comic, icon: "tv", message: "Literal status", onActivate: comic === "tap-to-play" ? () => {} : undefined,
    }));
    expect(html).toContain('aria-label="Literal status"');
    expect(html).not.toContain('class="lr-waiting-caption"');
  },
);

it("retains the real waiting scene in visual mode without text captions", () => {
  setCopy({ vis: true });
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "common.loading" }));
  expect(html).toContain('data-comic-motion="progress"');
  expect(html).not.toContain('class="lr-waiting-caption"');
});

it("uses the selected welcome entry's own symbols in visual mode", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  setCopy({ lang: "zh", vis: false });
  const entry = locales.zh.playful.welcome[0]!;
  expect(renderToStaticMarkup(createElement(WelcomeLine))).toContain(entry.text);
  setCopy({ vis: true });
  const cipher = renderToStaticMarkup(createElement(WelcomeCipher, { symbols: entry.symbols }));
  expect(renderToStaticMarkup(createElement(WelcomeLine))).toContain(cipher);
});

it("omits an empty language pool without hiding the real status or filling from another language", () => {
  const original = locales.zh.playful;
  locales.zh.playful = { welcome: [], waiting: [] };
  try {
    setCopy({ lang: "zh", vis: false });
    expect(renderToStaticMarkup(createElement(WelcomeLine))).toBe("");
    const loading = renderToStaticMarkup(createElement(LoadingStatus, { label: "common.loading" }));
    expect(loading).toContain(t("zh", "common.loading"));
    expect(loading).not.toContain("lr-waiting-caption");
  } finally {
    locales.zh.playful = original;
  }
});
