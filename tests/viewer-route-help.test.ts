import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { StageOverlay } from "../src/client/components/living/Stage";
import type { ViewerStage } from "../src/client/media/viewer-presentation";

it.each(["route-failed", "needs-play", "video-rejected"] satisfies ViewerStage[])(
  "shows the media route guide only for a failed route (%s)", viewerStage => {
    const html = renderToStaticMarkup(createElement(StageOverlay, {
      viewerStage, icon: "wifiOff", message: viewerStage,
    }));
    expect(html.includes("docs/guide/no-media-route")).toBe(viewerStage === "route-failed");
  },
);
