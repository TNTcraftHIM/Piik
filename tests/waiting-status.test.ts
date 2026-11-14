import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageOverlay } from "../src/client/components/living/Stage";
import { LoadingStatus } from "../src/client/components/living/WaitingStatus";
import { WelcomeLine } from "../src/client/components/living/WelcomeLine";
import { STATUS_SCENARIOS } from "../src/client/pages/status-preview-scenarios";
import { deriveViewerPresentation } from "../src/client/media/viewer-presentation";
import { deriveViewerStatus } from "../src/client/ui/media-status";
import { locales } from "../src/client/locales";
import { setCopy, t } from "../src/client/ui/copy";

afterEach(() => {
  setCopy({ lang: "zh" });
  vi.restoreAllMocks();
});

it.each(["zh", "en"] as const)("keeps %s waiting copy secondary to the actual operation", lang => {
  setCopy({ lang });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "client.launch.starting", waitingCaption: true }));
  expect(html).toContain(`aria-label="${t(lang, "client.launch.starting")}"`);
  expect(html).toContain('class="lr-brand-loader"');
  expect(html).not.toContain("data-comic-motion");
  expect(html).toContain('class="lr-waiting-caption" aria-hidden="true"');
  expect(html).toContain(locales[lang].playful.waiting[0]);
});

it.each(["common.loading", "gate.checking"] as const)("keeps routine %s feedback literal", label => {
  setCopy({ lang: "en" });
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label }));
  expect(html).toContain('class="lr-brand-loader"');
  expect(html).toContain(t("en", label));
  expect(html).not.toContain('class="lr-waiting-caption"');
  expect(html).not.toContain('data-comic-motion="progress"');
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

it.each(STATUS_SCENARIOS)("composes feedback from the actual $id state", scenario => {
  const presentation = deriveViewerPresentation(scenario.state);
  const { overlay } = deriveViewerStatus(presentation, scenario.state.signal);
  const waiting = presentation.overlay !== "none" &&
    ["joining", "preparing-p2p", "preparing-sfu", "waiting-sfu", "allocating",
      "receiving", "recovering", "waiting-host"].includes(presentation.stage);
  expect(overlay?.waiting ?? false).toBe(waiting);
  if (!overlay) return;
  const html = renderToStaticMarkup(createElement(StageOverlay, {
    ...overlay.status, message: t("zh", overlay.status.labelKey), waiting: overlay.waiting,
    onActivate: presentation.stage === "needs-play" ? () => {} : undefined,
  }));
  expect(html.includes('class="lr-waiting-caption"')).toBe(waiting);
  expect(html).not.toContain('class="lr-brand-loader"');
  expect(html.includes('class="lr-tv-big')).toBe(presentation.stage === "needs-play");
});

it("keeps a required action usable even if waiting was requested", () => {
  const html = renderToStaticMarkup(createElement(StageOverlay, {
    comic: "tap-to-play", icon: "play", message: "Play", waiting: true, onActivate: () => {},
  }));
  expect(html).toContain('<button type="button"');
  expect(html).toContain('is-action');
  expect(html).not.toContain('class="lr-waiting-caption"');
  expect(html).not.toContain('data-comic-motion="progress"');
});

it("keeps an informative static mascot in the reduced-motion preview", () => {
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "common.loading", still: true }));
  expect(html).toContain('class="lr-brand-mark"');
  expect(html).not.toContain("is-loop-");
  expect(html).toContain('aria-label="');
});

it.each(["zh", "en"] as const)("shows the selected %s welcome entry as text", lang => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  setCopy({ lang });
  const html = renderToStaticMarkup(createElement(WelcomeLine));
  expect(html).toContain(locales[lang].playful.welcome[0]!.text);
  expect(html).toContain('class="lr-welcome-text"');
});

it("omits an empty language pool without hiding the real status or filling from another language", () => {
  const original = locales.zh.playful;
  locales.zh.playful = { welcome: [], waiting: [] };
  try {
    setCopy({ lang: "zh" });
    expect(renderToStaticMarkup(createElement(WelcomeLine))).toBe("");
    const loading = renderToStaticMarkup(createElement(LoadingStatus, { label: "common.loading", waitingCaption: true }));
    expect(loading).toContain(t("zh", "common.loading"));
    expect(loading).not.toContain("lr-waiting-caption");
  } finally {
    locales.zh.playful = original;
  }
});
