import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CaptureSourcePicker } from "../src/client/components/living/CaptureSourcePicker";
import { setCopy, t } from "../src/client/ui/copy";

import {
  defaultNativeCapturePath,
  nativeCaptureTargetKey,
} from "../src/client/native/capture-selection";
import type {
  NativeAdapter,
  NativeCaptureTarget,
} from "../src/client/native/wire";

function target(
  title: string,
  sourceId: string,
): Extract<NativeCaptureTarget, { kind: "window" }> {
  return {
    kind: "window",
    title,
    sourceId,
    pid: 10,
    creationTime: "123456",
  };
}

describe("native capture source selection", () => {
  const game = target("My Game", "1");
  afterEach(() => setCopy({ lang: "en", vis: true }));

  it.each(["en", "zh", "vis"] as const)("keeps Browser capture reachable with an actionable App mismatch in %s", (mode) => {
    const lang = mode === "zh" ? "zh" : "en";
    setCopy({ lang, vis: mode === "vis" });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "incompatible" },
      initialTab: "browser",
      onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
      onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html).toContain(t(lang, "native.incompatible"));
    expect(html).toContain(`aria-label="${t(lang, "host.sourcePicker.browser")}"`);
    expect(html).not.toMatch(/data-source-tab="browser"[^>]*disabled=""/);
    expect(html).not.toContain(t(lang, "host.sourcePicker.empty"));
    expect(html).toContain('role="status"');
    expect(html).toContain('tabindex="0"');
  });

  it("uses the complete window identity as the UI key", () => {
    expect(nativeCaptureTargetKey(game)).toBe("window:1:10:123456");
    expect(
      nativeCaptureTargetKey({ ...game, creationTime: "654321" }),
    ).not.toBe(nativeCaptureTargetKey(game));
    expect(
      nativeCaptureTargetKey({
        kind: "display",
        sourceId: "2",
        title: "Display 1",
      }),
    ).toBe("display:2");
  });

  it.each(["unavailable", "unsupported", "failed"] as const)("does not describe %s as an empty list or block Browser capture", (kind) => {
    for (const mode of ["en", "zh", "vis"] as const) {
      const lang = mode === "zh" ? "zh" : "en";
      setCopy({ lang, vis: mode === "vis" });
      const props = {
        nativeSources: { kind }, onBrowser: () => {}, onNative: () => {},
        onPreview: async () => null, onRefresh: () => {}, onCancel: () => {},
      };
      const nativeTab = renderToStaticMarkup(createElement(CaptureSourcePicker, props));
      expect(nativeTab.replaceAll("&#x27;", "'")).toContain(t(lang, `host.sourcePicker.${kind}`));
      expect(nativeTab).not.toContain(t(lang, "host.sourcePicker.empty"));
      expect(nativeTab).not.toMatch(/class="lr-source-picker-refresh"[^>]*disabled=""/);
      const browserTab = renderToStaticMarkup(createElement(CaptureSourcePicker, { ...props, initialTab: "browser" }));
      expect(browserTab).toContain(`aria-label="${t(lang, "host.sourcePicker.browser")}"`);
      expect(browserTab).not.toContain(t(lang, `host.sourcePicker.${kind}`));
      expect(browserTab).not.toMatch(/class="lr-source-option is-browser"[^>]*disabled=""/);
    }
  });

  it.each(["browser", "window"] as const)("only adds waiting copy to the pending %s source list", initialTab => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "loading" }, initialTab,
      onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
      onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html.includes('class="lr-waiting-caption"')).toBe(initialTab === "window");
    expect(html).not.toContain("lr-brand-loader");
    expect(html).not.toMatch(/class="lr-source-picker-close"[^>]*disabled=""/);
  });

  it("separates windows from displays and locks Browser switching during native sharing", () => {
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: {
        kind: "ready",
        sources: [game, { kind: "display", sourceId: "2", title: "Display 1" }],
        processAudio: false,
        systemAudio: true,
      },
      browserAvailable: false,
      audioLocked: true,
      onBrowser: () => {},
      onNative: () => {},
      onPreview: async () => null,
      onRefresh: () => {},
      onCancel: () => {},
    }));
    expect(html).toContain('data-source-tab="browser"');
    expect(html).toMatch(/data-source-tab="browser"[^>]*disabled=""/);
    expect(html).toMatch(/data-native-source="window:1:10:123456"[^>]*disabled=""/);
    expect(html).not.toContain('data-native-source="display:2"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
  });

  it("retains the platform-owned combined source picker", () => {
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: {
        kind: "ready",
        sources: [{ kind: "picker", sourceId: "1", title: "System picker" }],
        processAudio: false,
        systemAudio: true,
      },
      onBrowser: () => {},
      onNative: () => {},
      onPreview: async () => null,
      onRefresh: () => {},
      onCancel: () => {},
    }));
    expect(html).toContain('data-native-source="picker:1"');
    expect(html).toContain('aria-checked="true"');
  });

  it.each(["browser", "window"] as const)("blocks %s confirmation during owning page work while retaining cancel", (initialTab) => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "ready", sources: [game], processAudio: false, systemAudio: false },
      initialTab, selectionDisabled: true,
      onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
      onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html).toMatch(/class="lr-source-option(?: is-browser)?"[^>]*disabled=""/);
    expect(html).not.toMatch(/class="lr-source-picker-close"[^>]*disabled=""/);
  });

  it.each(["en", "zh", "vis"] as const)("offers the requested border preference only for supported native capture in %s", (mode) => {
    const lang = mode === "zh" ? "zh" : "en";
    setCopy({ lang, vis: mode === "vis" });
    const render = (supported: boolean | undefined, initialTab: "window" | "display" | "browser", initialShowCaptureBorder?: boolean) =>
      renderToStaticMarkup(createElement(CaptureSourcePicker, {
        nativeSources: { kind: "ready", sources: [game], processAudio: true, systemAudio: true, captureBorderControl: supported },
        initialTab, initialShowCaptureBorder,
        onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
        onRefresh: () => {}, onCancel: () => {},
      }));
    const label = t(lang, "host.sourcePicker.showCaptureBorder");
    for (const tab of ["window", "display"] as const) {
      expect(render(true, tab)).toContain(`aria-checked="false" aria-label="${label}"`);
      expect(render(true, tab, true)).toContain(`aria-checked="true" aria-label="${label}"`);
      expect(render(true, tab)).toContain(`aria-description="${t(lang, "host.sourcePicker.showCaptureBorderHint")}"`);
      expect(render(false, tab, true)).not.toContain(label);
      expect(render(undefined, tab, true)).not.toContain(label);
    }
    expect(render(true, "browser", true)).not.toContain(label);
  });
});

describe("native adapter selection", () => {
  const adapters: NativeAdapter[] = [
    { index: 0, name: "GPU A", identity: "a", hardwareH264: [] },
    {
      index: 1,
      name: "GPU B",
      identity: "b",
      hardwareH264: [{ index: 0, name: "H264", identity: "encoder" }],
    },
  ];

  it("selects the first complete hardware path for UI capture", () => {
    expect(defaultNativeCapturePath(adapters)).toEqual({
      adapterIndex: 1,
      encoderIndex: 0,
    });
    expect(defaultNativeCapturePath([adapters[0]!])).toBeNull();
  });

  it("uses software VP8 only when that capture capability exists", () => {
    expect(defaultNativeCapturePath(adapters, "vp8", true)).toEqual({
      adapterIndex: 0, encoderIndex: 0,
    });
    expect(defaultNativeCapturePath(adapters, "vp8", false)).toBeNull();
    expect(defaultNativeCapturePath(adapters, "auto", true)?.adapterIndex).toBe(1);
    expect(defaultNativeCapturePath([adapters[0]!], "auto", true)?.adapterIndex).toBe(0);
    expect(defaultNativeCapturePath([adapters[0]!], "h264", true)).toBeNull();
  });
});
