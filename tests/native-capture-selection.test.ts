import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CaptureSourcePicker } from "../src/client/components/living/CaptureSourcePicker";
import { AudioExclusionSelect } from "../src/client/components/living/AudioExclusionSelect";
import { CameraSources } from "../src/client/components/living/CameraSources";
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

  it("shows one system chooser for picker-only Apps instead of duplicate desktop tabs", () => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "ready", sources: [{ kind: "picker", sourceId: "1", title: "Choose on device" }], processAudio: false, systemAudio: true },
      onBrowser() {}, onNative() {}, onCamera() {}, onPreview: async () => null, onRefresh() {}, onCancel() {},
    }));
    expect(html).toMatch(/data-source-tab="picker"[^>]*aria-selected="true"/);
    expect(html).not.toContain('data-source-tab="window"');
    expect(html).not.toContain('data-source-tab="display"');
    expect(html).toContain('data-source-tab="browser"');
    expect(html).toContain('data-source-tab="camera"');
    expect(html).toContain(t("en", "host.sourcePicker.systemAction"));
    expect(html).toContain('class="lr-source-option is-action"');
    expect(html).not.toContain('class="lr-source-option-preview"');
  });

  it("omits unsupported Browser capture while keeping the system chooser and Camera", () => {
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "ready", sources: [{ kind: "picker", sourceId: "1", title: "Choose on device" }], processAudio: false, systemAudio: true },
      browserSupported: false,
      onBrowser() {}, onNative() {}, onCamera() {}, onPreview: async () => null, onRefresh() {}, onCancel() {},
    }));
    expect([...html.matchAll(/data-source-tab="([^"]+)"/g)].map(match => match[1]))
      .toEqual(["camera", "picker"]);
    expect(html).toMatch(/data-source-tab="picker"[^>]*aria-selected="true"/);
  });

  it("keeps an explicitly selected system chooser while refreshing without offering stale sources", () => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "loading", appDetected: true,
        sources: [{ kind: "picker", sourceId: "1", title: "Choose on device" }] },
      initialTab: "picker", browserSupported: false,
      onBrowser() {}, onNative() {}, onCamera() {}, onPreview: async () => null, onRefresh() {}, onCancel() {},
    }));
    expect([...html.matchAll(/data-source-tab="([^"]+)"/g)].map(match => match[1]))
      .toEqual(["camera", "picker"]);
    expect(html).toMatch(/data-source-tab="picker"[^>]*aria-selected="true"/);
    expect(html).toContain(`role="status" aria-label="${t("en", "host.sourcePicker.loading")}"`);
    expect(html).not.toContain('class="lr-source-option is-action"');
    expect(html).not.toContain('data-camera-source=');
  });

  it("shows the existing no-source result when neither Browser API nor App capture is available", () => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "browser" }, browserSupported: false, cameraSupported: false,
      onBrowser() {}, onNative() {}, onPreview: async () => null, onRefresh() {}, onCancel() {},
    }));
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("is-action");
    expect(html).toContain(t("en", "host.capture.noSource"));
  });

  it("keeps enumerated cameras selectable while optional thumbnails load", () => {
    const props = {
      sources: [{ id: "front", label: "Front camera", preview: null }],
      busy: true, error: null, selected: "", onSelect: () => {},
    };
    const html = renderToStaticMarkup(createElement(CameraSources, { ...props, disabled: false }));
    expect(html).toContain('data-camera-source="front"');
    expect(html).not.toContain('disabled=""');
    expect(renderToStaticMarkup(createElement(CameraSources, { ...props, disabled: true })))
      .toContain('disabled=""');
  });

  it.each(["en", "zh", "vis"] as const)("keeps Browser capture reachable with an actionable App mismatch in %s", (mode) => {
    const lang = mode === "zh" ? "zh" : "en";
    setCopy({ lang, vis: mode === "vis" });
    const props = {
      nativeSources: { kind: "incompatible" },
      onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
      onRefresh: () => {}, onCancel: () => {},
    } as const;
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, { ...props, initialTab: "browser" }));
    expect(html).not.toContain(t(lang, "native.incompatible"));
    expect(html).toContain(`aria-label="${t(lang, "host.sourcePicker.browser")}"`);
    expect(html).not.toMatch(/data-source-tab="browser"[^>]*disabled=""/);
    expect(html).not.toContain(t(lang, "host.sourcePicker.empty"));
    expect(html).not.toContain('role="status"');
    const nativeTab = renderToStaticMarkup(createElement(CaptureSourcePicker, { ...props, initialTab: "window" }));
    expect(nativeTab).toContain(t(lang, "native.incompatible"));
    expect(nativeTab).toContain('role="status"');
  });

  it("keeps pending native selection from implicitly opening a mobile camera", () => {
    const props = { onBrowser: () => {}, onNative: () => {}, onCamera: () => {},
      onPreview: async () => null, onRefresh: () => {}, onCancel: () => {},
      browserAvailable: false, cameraAvailable: true };
    const pending = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      ...props, nativeSources: { kind: "loading" }, initialTab: "window",
    }));
    expect(pending).toMatch(/aria-selected="true"[^>]*data-source-tab="window"|data-source-tab="window"[^>]*aria-selected="true"/);
    const explicit = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      ...props, nativeSources: { kind: "loading" }, initialTab: "camera",
    }));
    expect(explicit).toMatch(/aria-selected="true"[^>]*data-source-tab="camera"|data-source-tab="camera"[^>]*aria-selected="true"/);
    const browser = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      ...props, nativeSources: { kind: "browser" }, initialTab: "window",
    }));
    expect(browser).toMatch(/aria-selected="true"[^>]*data-source-tab="camera"|data-source-tab="camera"[^>]*aria-selected="true"/);
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

  it("keeps a missing exclusion selected and distinguishes a restarted process", () => {
    setCopy({ lang: "en", vis: false });
    const restarted = { ...game, creationTime: "654321" };
    const html = renderToStaticMarkup(createElement(AudioExclusionSelect, {
      sources: [restarted, { ...restarted, sourceId: "2" }],
      value: game, onChange: () => {},
    }));
    expect(html).toMatch(/<option value="10:123456" disabled="" selected="">/);
    expect(html.match(/<option value="10:654321"/g)).toHaveLength(1);
    expect(html).not.toMatch(/<option value="" selected="">/);
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
      if (kind === "unavailable") {
        expect(nativeTab).not.toContain('data-source-tab="window"');
        expect(nativeTab).not.toContain('data-source-tab="display"');
        expect(nativeTab).toMatch(/data-source-tab="browser"[^>]*aria-selected="true"/);
      }
      if (kind === "unavailable") expect(nativeTab).not.toContain('role="status"');
      else expect(nativeTab.replaceAll("&#x27;", "'")).toContain(t(lang, `host.sourcePicker.${kind}`));
      expect(nativeTab).not.toContain(t(lang, "host.sourcePicker.empty"));
      expect(nativeTab).not.toMatch(/class="lr-source-picker-refresh"[^>]*disabled=""/);
      const browserTab = renderToStaticMarkup(createElement(CaptureSourcePicker, { ...props, initialTab: "browser" }));
      expect(browserTab).toContain(`aria-label="${t(lang, "host.sourcePicker.browser")}"`);
      const browserCopy = browserTab.replaceAll("&#x27;", "'");
      expect(browserCopy).not.toContain('role="status"');
      expect(browserTab).not.toMatch(/class="lr-source-option is-action"[^>]*disabled=""/);
    }
  });

  it.each(["browser", "window"] as const)("keeps Browser and Camera reachable during discovery with initial %s preference", initialTab => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "loading" }, initialTab,
      onBrowser: () => {}, onNative: () => {}, onPreview: async () => null,
      onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html).toMatch(new RegExp(`data-source-tab="${initialTab}"[^>]*aria-selected="true"`));
    expect(html).not.toMatch(/data-source-tab="browser"[^>]*disabled=""/);
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
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect([...html.matchAll(/data-source-tab="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["browser", "camera", "window", "display"]);
    expect(html).toMatch(/data-source-tab="window"[^>]*aria-selected="true"/);
  });

  it("offers only Browser and Camera without an App, defaulting to Browser", () => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "browser" }, onBrowser: () => {}, onCamera: () => {},
      onNative: () => {}, onPreview: async () => null, onRefresh: () => {}, onCancel: () => {},
    }));
    expect([...html.matchAll(/data-source-tab="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["browser", "camera"]);
    expect(html).toMatch(/data-source-tab="browser"[^>]*aria-selected="true"/);
    expect(html).not.toMatch(/data-source-tab="camera"[^>]*disabled=""/);
    expect(html).not.toContain('role="status"');
  });

  it("selects a focusable Camera tab when Browser sharing is unavailable", () => {
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "browser" }, browserAvailable: false,
      onBrowser: () => {}, onCamera: () => {}, onNative: () => {},
      onPreview: async () => null, onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html).toMatch(/data-source-tab="camera"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect(html).toMatch(/data-source-tab="browser"[^>]*tabindex="-1"[^>]*disabled=""/);
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
    expect(html).toMatch(/class="lr-source-option(?: is-action)?"[^>]*disabled=""/);
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
