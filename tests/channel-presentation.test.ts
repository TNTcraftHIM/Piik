import { describe, expect, it } from "vitest";
import { screenTitle } from "../src/client/channel/presentation";

describe("screen titles", () => {
  it("keeps a custom title across source replacement, then clears to the latest source", () => {
    const publication = { source: { kind: "screen" as const, name: "First window" }, title: null as string | null };
    expect(screenTitle(publication, "en")).toBe("First window");
    publication.title = "Movie night";
    publication.source.name = "Second window";
    expect(screenTitle(publication, "en")).toBe("Movie night");
    publication.title = null;
    expect(screenTitle(publication, "en")).toBe("Second window");
  });

  it("localizes only missing source names and preserves literal human titles", () => {
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, "zh")).toBe("分享画面");
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, "en")).toBe("Shared screen");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, "zh")).toBe("摄像头");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, "en")).toBe("Camera");
    expect(screenTitle({ source: { kind: "screen", name: "<窗口>" }, title: "<Movie>" }, "en")).toBe("<Movie>");
  });
});
