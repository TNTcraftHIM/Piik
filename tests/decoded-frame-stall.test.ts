import { describe, expect, it } from "vitest";

import {
  DecodedFrameStallDetector,
  ROUTE_DECODED_FRAME_STALL_MS,
} from "../src/client/media/decoded-frame-stall.ts";

describe("DecodedFrameStallDetector", () => {
  it("reports one exact active stall and resets on progress or identity change", () => {
    const detector = new DecodedFrameStallDetector();
    expect(detector.observe("peer:1:a", null, 0)).toBe(false);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS),
    ).toBe(true);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS + 1),
    ).toBe(false);
    expect(detector.observe("peer:1:a", 1, ROUTE_DECODED_FRAME_STALL_MS + 2)).toBe(
      false,
    );
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS * 2 + 2),
    ).toBe(true);
    expect(detector.observe("sfu:2:b", 0, ROUTE_DECODED_FRAME_STALL_MS * 3)).toBe(
      false,
    );
  });

  it("suppresses and rebases progress while paused", () => {
    const detector = new DecodedFrameStallDetector();
    detector.observe("peer:1:a", 0, 0);
    detector.setPaused(true, ROUTE_DECODED_FRAME_STALL_MS);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS * 3),
    ).toBe(false);
    detector.setPaused(false, ROUTE_DECODED_FRAME_STALL_MS * 3);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS * 4 - 1),
    ).toBe(false);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS * 4),
    ).toBe(true);
  });

  it("rebases elapsed time after the page resumes", () => {
    const detector = new DecodedFrameStallDetector();
    detector.observe("peer:1:a", 0, 0);
    detector.rebaseline(ROUTE_DECODED_FRAME_STALL_MS * 4);

    expect(
      detector.observe(
        "peer:1:a",
        null,
        ROUTE_DECODED_FRAME_STALL_MS * 5 - 1,
      ),
    ).toBe(false);
    expect(
      detector.observe(
        "peer:1:a",
        0,
        ROUTE_DECODED_FRAME_STALL_MS * 5,
      ),
    ).toBe(true);
  });

  it("retries an exact stall when its failure message was not sent", () => {
    const detector = new DecodedFrameStallDetector();
    expect(detector.observe("peer:1:a", 0, 0)).toBe(false);
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS),
    ).toBe(true);
    detector.allowReportRetry();
    expect(
      detector.observe("peer:1:a", 0, ROUTE_DECODED_FRAME_STALL_MS + 1),
    ).toBe(true);
  });
});
