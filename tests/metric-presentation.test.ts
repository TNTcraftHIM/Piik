import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectionSummaryCells, MetricCells } from "../src/client/components/living/Metrics";
import { EMPTY_METRICS } from "../src/client/types";
import { setCopy, t } from "../src/client/ui/copy";

beforeEach(() => setCopy({ lang: "en" }));

describe("observed metric presentation", () => {
  it("labels measured sender output and receiver decoding across details and summaries", () => {
    const samples = [60, 120].map(framesPerSecond => ({
      connectionId: String(framesPerSecond), metrics: { ...EMPTY_METRICS, framesPerSecond },
    }));
    for (const [direction, label] of [["send", "Output FPS"], ["receive", "Decoded FPS"]] as const) {
      const detail = renderToStaticMarkup(createElement(MetricCells, {
        direction, metrics: samples[1]!.metrics, expanded: false,
      }));
      expect(detail).toContain(label);
      expect(detail).toContain("120.0 fps");
      const summary = renderToStaticMarkup(createElement(ConnectionSummaryCells, {
        direction, media: "video", samples,
      }));
      expect(summary).toContain(label + " range");
      expect(summary).toContain("60.0–120.0 fps");
      const missing = renderToStaticMarkup(createElement(MetricCells, {
        direction, metrics: EMPTY_METRICS, expanded: false,
      }));
      expect(missing).not.toContain(label);
      expect(missing).not.toMatch(/\d fps/);
    }
  });

  it("reports dropped frames from the current sampling interval, not the connection lifetime", () => {
    const render = (intervalFramesDropped: number | null) => renderToStaticMarkup(createElement(MetricCells, {
      metrics: { ...EMPTY_METRICS, framesDropped: 300, intervalFramesDropped },
      direction: "receive", expanded: true, onToggle() {},
    }));
    expect(render(2)).toContain(`${t("en", "stats.dropped")} · 2 `);
    expect(render(0)).toContain(`${t("en", "stats.dropped")} · 0 `);
    expect(render(null)).not.toContain(t("en", "stats.dropped"));
    expect(render(2)).not.toContain(`${t("en", "stats.dropped")} · 300`);
  });

  it("keeps an unrecognized sender reason distinct from no limitation", () => {
    const render = (qualityLimitationReason: string) => renderToStaticMarkup(createElement(MetricCells, {
      metrics: { ...EMPTY_METRICS, qualityLimitationReason },
      direction: "send", expanded: true, onToggle() {},
    }));
    expect(render("none")).toContain(t("en", "stats.quality.normal"));
    expect(render("future-limit")).toContain(t("en", "stats.quality.unclassified"));
    expect(render("future-limit")).not.toContain(t("en", "stats.quality.normal"));
  });

});
