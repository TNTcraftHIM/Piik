import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageOverlay } from "../src/client/components/living/Stage";
import { LoadingStatus, WAITING_LINES } from "../src/client/components/living/WaitingStatus";
import { setCopy, t } from "../src/client/ui/copy";

afterEach(() => setCopy({ lang: "zh", vis: false }));

it.each(["zh", "en"] as const)("keeps %s waiting copy secondary to the actual operation", lang => {
  setCopy({ lang, vis: false });
  const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "client.launch.starting" }));
  expect(html).toContain(`aria-label="${t(lang, "client.launch.starting")}"`);
  expect(html).toContain('class="lr-waiting-caption" aria-hidden="true"');
  expect(WAITING_LINES).toHaveLength(20);
  expect(new Set(WAITING_LINES.map(key => t(lang, key))).size).toBe(20);
  // Short waits show only the actual status and existing motion.
  for (const key of WAITING_LINES) expect(html).not.toContain(t(lang, key));
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
