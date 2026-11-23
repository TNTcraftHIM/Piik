import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ChannelSession } from "../src/client/channel/session";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConnectionButton } from "../src/client/components/living/AppConnectionButton";
import type { AppNavigationIssue } from "../src/client/components/living/OpenInClient";
import { AppReleaseNotice } from "../src/client/components/living/AppReleaseNotice";
import { CaptureSourcePicker } from "../src/client/components/living/CaptureSourcePicker";
import { ChannelShareControl } from "../src/client/channel/components/ChannelShareControl";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import type { ChannelController } from "../src/client/channel/types";
import type { AppDiscoveryOptions } from "../src/client/native/discovery";
import { setCopy, t } from "../src/client/ui/copy";
import { APP_PROTOCOL, channelAppDiscovery } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { NATIVE_CLIENT_PORT_START } from "../src/client/native/discovery-ports";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

describe("shared App connection entry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps reopened approval guidance pending without failure or retry", () => {
    setCopy({ lang: "en" });
    vi.mocked(useState).mockReturnValueOnce(["approving", vi.fn()]).mockReturnValueOnce([true, vi.fn()]);
    const html = renderToStaticMarkup(createElement(AppConnectionButton, { connected: false }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`aria-label="${t("en", "client.connect.approving")}"`);
    expect(html).toContain('data-comic-tone="busy" data-comic-motion="progress"');
    expect(html).not.toContain('data-comic-tone="bad"');
    expect(html).not.toContain(`aria-label="${t("en", "common.retry")}"`);
  });

  it("omits the Android wake action when its embedding surface disables it", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 16) Mobile" });
    const render = (wakeURL?: string | null) => {
      vi.mocked(useState).mockReturnValueOnce(["unavailable", vi.fn()]);
      return renderToStaticMarkup(createElement(AppConnectionButton, { wakeURL }));
    };
    expect(render()).toContain("intent://app#Intent;scheme=piik;");
    expect(render(null)).not.toContain("intent://app");
  });

  it("uses one native link to open update management without another discovery click", () => {
    setCopy({ lang: "en" });
    const html = renderToStaticMarkup(createElement(AppReleaseNotice, {
      update: { kind: "update-available", version: "v3.1.0", revision: "b".repeat(40),
        url: "https://github.com/TNTcraftHIM/Piik/releases/tag/v3.1.0",
        releaseURL: "https://github.com/TNTcraftHIM/Piik/releases/tag/v3.1.0" },
      managementURL: "http://127.0.0.1:39721/client",
    }));
    expect(html).toContain('href="http://127.0.0.1:39721/client" target="_blank" rel="noopener noreferrer" aria-label="Update in App"');
    expect(html).not.toContain("?site=");
  });

  it("keeps an unconnected owner discoverable even after App permission is verified", () => {
    setCopy({ lang: "en" });
    const render = (connected?: boolean) => {
      vi.mocked(useState).mockReturnValueOnce(["ready", vi.fn()]);
      return renderToStaticMarkup(createElement(AppConnectionButton, { connected }));
    };
    const disconnected = render(false);
    expect(disconnected).not.toContain("lr-app-connect is-ready");
    expect(disconnected).toContain(`aria-label="${t("en", "client.connect.action")}"`);
    for (const connected of [true, undefined]) {
      const ready = render(connected);
      expect(ready).toContain("lr-app-connect is-ready is-quiet");
      expect(ready).toContain(`aria-label="${t("en", "client.connect.manage")}"`);
    }
  });

  it("offers bookmarks directly from verified management without update support or another connection click", () => {
    setCopy({ lang: "en" });
    vi.stubGlobal("window", { location: { origin: "https://site.example" } });
    vi.mocked(useState).mockReturnValueOnce(["ready", vi.fn()])
      .mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([false, vi.fn()])
      .mockReturnValueOnce([undefined, vi.fn()])
      .mockReturnValueOnce([{ url: "http://127.0.0.1:39721/client", updateSupported: false }, vi.fn()]);
    const html = renderToStaticMarkup(createElement(AppConnectionButton, { connected: true }));
    expect(html).toContain('target="_blank" rel="noopener noreferrer" aria-label="Bookmarks"');
    expect(html).toContain("bookmarks=1");
    expect(html).toContain("piik-lang=en");
    expect(html.match(/aria-label="Bookmarks"/g)).toHaveLength(1);
    expect(html).toContain('class="lr-btn is-compact lr-app-connect is-ready is-quiet"');
    const url = new URL(html.match(/href="([^"]+)" target="_blank" rel="noopener noreferrer" aria-label="Bookmarks"/)![1].replaceAll("&amp;", "&"));
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:39721/client");
    expect(url.searchParams.get("bookmarks")).toBe("1");
    expect(url.searchParams.has("site")).toBe(false);
    expect(url.searchParams.get("piik-preferences")).toBe("copy,theme");
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toMatchObject({ site: "https://site.example", "piik-client": "1", "piik-lang": "en" });
  });

  it.each([
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "iPhone", 5],
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)", "iPad", 5],
    ["desktop-mode iPad", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 5],
    ["Android phone", "Mozilla/5.0 (Linux; Android 16) Mobile", "Linux armv8l", 5],
    ["Android tablet", "Mozilla/5.0 (Linux; Android 16)", "Linux armv8l", 5],
    ["touch Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 10],
    ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 0],
    ["Linux", "Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 0],
    ["unknown", "", "", 0],
  ])("offers the same connection entry on %s without hiding Browser capture", (_, userAgent, platform, maxTouchPoints) => {
    vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
    expect(renderToStaticMarkup(createElement(AppConnectionButton))).toContain("lr-app-connect");
    const html = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "browser" },
      onBrowser: () => {}, onNative: () => {}, onCamera: () => {},
      onPreview: async () => null, onRefresh: () => {}, onCancel: () => {},
    }));
    expect(html).toContain('data-source-tab="browser"');
    expect(html).toContain('data-source-tab="camera"');
    expect(html).not.toContain("lr-source-app-connection");
    expect(html).not.toContain("lr-app-connect");
  });

  it.each([
    { camera: true, display: false },
    { camera: true, display: true },
    { camera: false, display: true },
    { camera: false, display: false },
  ])("keeps watch together available while camera/display sources follow their capabilities ($camera/$display)", entry => {
    setCopy({ lang: "en" });
    vi.stubGlobal("navigator", { mediaDevices: {
      ...(entry.camera ? { getUserMedia: vi.fn() } : {}),
      ...(entry.display ? { getDisplayMedia: vi.fn() } : {}),
    } });
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: false, pending: new Set(), browserCapturePreparation: () => undefined, nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined, externalInput: () => undefined } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", disabled: false }));
    const button = html.match(/<button\b[^>]*>/)![0];
    expect(button.includes("disabled")).toBe(false);
    expect(button.toLowerCase().includes("popovertarget=")).toBe(true);
    expect(html.match(/<button\b/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Close"');
    expect(html).toMatch(/aria-label="(?:Share settings|分享设置)"/);
    const picker = renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources: { kind: "browser" }, initialTab: "browser", browserSupported: entry.display, cameraSupported: entry.camera,
      onBrowser: vi.fn(), onWatch: vi.fn(), onCamera: vi.fn(), onNative: vi.fn(), onPreview: async () => null,
      onRefresh: vi.fn(), onCancel: vi.fn(),
    }));
    expect(picker).toContain('data-source-tab="browser"');
    expect(picker.includes('data-source-tab="camera"')).toBe(entry.camera);
    const capture = picker.match(/<button\b[^>]*aria-label="Share a screen"[^>]*>/)![0];
    expect(capture.includes("disabled")).toBe(!entry.display);
    const watch = picker.match(/<button\b[^>]*aria-label="Watch together"[^>]*>/)![0];
    expect(watch.includes("disabled")).toBe(false);
  });
  it("binds live controls to their owned publication without retargeting a retired source", () => {
    setCopy({ lang: "en" });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn() } });
    const ownedScreens = new Set(["mine", "voice"]);
    const screenQuality = vi.fn(() => ({ applied: DEFAULT_QUALITY_SETTINGS, requested: DEFAULT_QUALITY_SETTINGS }));
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: false, pending: new Set(), browserCapturePreparation: () => undefined, nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined, externalInput: () => undefined,
      screenQuality, screenCodecMode: () => undefined, screenEncodingExecution: () => undefined,
      sourceAudio: () => undefined, sourceMicrophone: () => undefined,
      ownedScreens, streams: new Map(), state: { channel: { rooms: [{ id: "room", name: "Friday" }] }, publications: [
        { id: "other-endpoint", roomId: "room", kind: "screen", userId: "self" },
        { id: "voice", roomId: "room", kind: "voice", userId: "self" },
        { id: "mine", roomId: "room", kind: "screen", userId: "self" },
      ], voice: [], watchActivities: [], watchSubscriptions: [] },
    } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", publicationId: "mine", compact: true, disabled: false }));
    expect(html).toMatch(/aria-label="(?:Switch source in Friday|切换Friday的分享源)"/);
    expect(html.match(/<button\b/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Close"');
    expect(html).toMatch(/aria-label="(?:Share settings in Friday|Friday的分享设置)"/);
    const header = renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", disabled: false }));
    expect(header).toContain('aria-label="Switch source in Friday"');
    expect(header).toContain('aria-label="Share settings in Friday"');
    expect(screenQuality.mock.calls).toEqual([["mine"], ["mine"]]);
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", publicationId: "retired", disabled: false }))).toBe("");
    const elsewhere = renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "other", disabled: false }));
    expect(elsewhere).not.toMatch(/aria-label="(?:Switch source|切换来源)"/);
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "other", publicationId: "mine", disabled: false }))).toBe("");
    ownedScreens.clear();
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", publicationId: "mine", disabled: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", disabled: false }))).toContain(`aria-label="${t("en", "host.start")}"`);
  });
});

describe("Native sharing capabilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["picker", "preparing"] as const)("Browser preparation exposes %s as a live status with a scoped Cancel", phase => {
    setCopy({ lang: "en" });
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, pending: new Set(["screen:room"]), appConnected: false,
      browserCapturePreparation: () => phase, sourceSelectionCommitting: () => false,
      nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined, externalInput: () => undefined,
    } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "room", disabled: false, onWatch() {} }));
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain(t("en", phase === "picker" ? "host.capture.chooseInSystem" : "host.capture.preparingPicture"));
    expect(html).toContain(t("en", "host.capture.cancelPreparationHint"));
    const cancel = html.match(/<button\b[^>]*aria-label="Cancel preparation"[^>]*>/)![0];
    expect(cancel).not.toContain("disabled");
  });

  it("derives Native availability from retained capabilities and the source's codec mode", () => {
    setCopy({ lang: "en" });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn(), getUserMedia: vi.fn() } });
    const sources = { kind: "ready", codecs: ["h264"], softwareEncodingCodecs: ["h264"], processAudio: false, systemAudio: false,
      sources: [{ kind: "window", sourceId: "1", title: "Owned Native window", pid: 1, creationTime: "1" }] };
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: true, pending: new Set(),
      videoCodecMode: "vp8", encodingExecution: "software", screenEncodingExecution: () => "software", browserCapturePreparation: () => undefined, nativeCaptureRequest: () => undefined,
      nativeCaptureSelection: (): ReturnType<ChannelController["nativeCaptureSelection"]> => undefined,
      externalInput: (): ReturnType<ChannelController["externalInput"]> => undefined,
      screenQuality: () => undefined, screenCodecMode: () => "h264", sourceAudio: () => undefined, sourceMicrophone: () => undefined,
      ownedScreens: new Set<string>(), streams: new Map(), state: { channel: { rooms: [{ id: "room", name: "Friday" }] }, publications: [] as { id: string; roomId: string; kind: "screen"; source: { kind: "screen" } }[], voice: [], watchActivities: [], watchSubscriptions: [] },
    };
    const render = (settings = false) => {
      // Open the real picker with the same completed targets response on each render.
      vi.mocked(useState).mockReturnValueOnce([!settings, vi.fn()]).mockReturnValueOnce([settings, vi.fn()])
        .mockReturnValueOnce([false, vi.fn()])
        .mockReturnValueOnce([sources, vi.fn()]);
      return renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel: channel as unknown as ChannelController,
        roomId: "room", publicationId: channel.ownedScreens.has("mine") ? "mine" : undefined, disabled: false }));
    };
    expect(render(true)).not.toContain('aria-label="Encoding method"');
    channel.videoCodecMode = "auto";
    expect(render(true)).toContain('aria-label="Encoding method"');
    expect(render(true)).toContain('value="software" aria-pressed="true"');
    sources.softwareEncodingCodecs = ["vp8"];
    expect(render(true)).not.toContain('aria-label="Encoding method"');
    sources.softwareEncodingCodecs = ["h264"];
    channel.videoCodecMode = "vp8";
    const unsupported = render();
    expect(unsupported.replaceAll("&#x27;", "'")).toContain(t("en", "host.sourcePicker.unsupported"));
    expect(unsupported).not.toContain("data-native-source=");
    expect(unsupported).toContain('data-source-tab="browser"');
    expect(unsupported).toContain('data-source-tab="camera"');

    channel.videoCodecMode = "h264";
    expect(render()).toContain("data-native-source=");
    expect(sources.codecs).toEqual(["h264"]);
    sources.codecs = [];
    channel.videoCodecMode = "auto";
    expect(render().replaceAll("&#x27;", "'")).toContain(t("en", "host.sourcePicker.unsupported"));

    sources.codecs = ["h264"];
    channel.state.publications.push({ id: "mine", roomId: "room", kind: "screen", source: { kind: "screen" } });
    channel.ownedScreens.add("mine");
    channel.videoCodecMode = "vp8";
    const sharing = render(true);
    expect(sharing).not.toContain('aria-label="Encoding method"'); // Current Browser source ignores Native preferences.
    channel.nativeCaptureSelection = () => ({ current: true, target: { kind: "display", sourceId: "1", title: "Display" }, audio: false, showCaptureBorder: false });
    const nativeSettings = render(true);
    expect(nativeSettings).toContain('aria-label="Encoding method"');
    expect(nativeSettings.match(/<button[^>]*value="software"[^>]*>/)?.[0]).toContain('aria-disabled="true"');
    channel.externalInput = () => ({ state: "waiting", publicationId: "mine", endpoint: "http://localhost", token: "preview" });
    expect(render(true)).not.toContain('aria-label="Encoding method"');
    channel.externalInput = () => undefined;
    expect(sharing).toContain('value="h264" aria-pressed="true"');
    for (const mode of ["auto", "h264", "vp8"]) expect(sharing).toContain(`value="${mode}"`);
    expect(render()).toContain("data-native-source=");
  });
});

// Exercise the button's actual operation and unmount effect without a Browser.
// Discovery has separate transport tests; this covers who may activate a page.
const source = ts.createSourceFile("AppConnectionButton.tsx", readFileSync(
  new URL("../src/client/components/living/AppConnectionButton.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let connect: string | undefined;
let rememberBuild: string | undefined;
let connectionProps: string | undefined;
const effects: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "AppConnectionButton") connectionProps = node.parameters[0]!.getText(source);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "connect") connect = node.getText(source);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "rememberBuild") rememberBuild = node.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    effects.push(node.arguments[0]!.getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!connect || !effects.length) throw new Error("Missing App connection operation or cleanup");
const executable = ts.transpileModule(`${rememberBuild}\n${connect}\nconst cleanups = [${effects.map(effect => effect.includes("else if (!connected") ? `(automatic ? (${effect})() : undefined)` : `(${effect})()`).join(",")}];
  ({ connect, cleanup: () => cleanups.reverse().forEach(fn => fn?.()) });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const site = "https://site.example";
const approval = `http://127.0.0.1:39721/client?site=${encodeURIComponent(site)}`;

function mount(activated = false, state: "idle" | "ready" = "idle", android = false, connected?: boolean, discovery?: typeof channelAppDiscovery,
  automatic = false, available = true, navigationIssue: AppNavigationIssue | null = null, connectedPort?: number) {
  const popup = { closed: false, close: vi.fn(() => { popup.closed = true; }) };
  const window = Object.assign(new EventTarget(), { open: vi.fn((): typeof popup | null => popup), location: { origin: site, assign: vi.fn() } });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const native = {
    discoverNativeConnect: vi.fn(async (_options: AppDiscoveryOptions): Promise<string | null> => approval),
    discoverNativeHealth: vi.fn(async (_options: { signal: AbortSignal; waitForPermission?: boolean }): Promise<object | null> =>
      activated || window.open.mock.calls.length > 0 ? {} : null),
    NativeCompatibilityError: class extends Error {},
  };
  const pending = { current: null as { controller: AbortController; cancel?: () => void } | null };
  const healthCheck = { current: null as AbortController | null };
  const help = { current: { hidePopover: vi.fn(), matches: vi.fn(() => false) } };
  const showHelp = vi.fn();
  const setState = vi.fn();
  const setNavigationIssue = (update: (issue: AppNavigationIssue | null) => AppNavigationIssue | null) => {
    navigationIssue = update(navigationIssue);
  };
  const setBuild = vi.fn();
  const setManagement = vi.fn();
  const activateClient = vi.fn();
  const onConnected = vi.fn();
  const operation = runInNewContext(executable, {
    automatic, automaticFailed: { current: false }, connectedPort, window, document, pending, healthCheck, help, showHelp, setState, setAutomaticHint: vi.fn(), setManagement, setBuild, activateClient, onConnected, AbortController, URL, URLSearchParams,
    wakeURL: android ? "intent://app#Intent;scheme=piik;package=tv.piik.android;end" : null,
    state, connected, available, ready: state === "ready" && connected !== false, setNavigationIssue, isClientActivated: () => activated,
    discovery: discovery ?? { health: native.discoverNativeHealth, connect: native.discoverNativeConnect,
      isIncompatible: (error: unknown) => error instanceof native.NativeCompatibilityError },
    watchClientActivation: (changed: () => void) => {
      window.addEventListener("activation", changed);
      return () => window.removeEventListener("activation", changed);
    },
  }) as { connect: (wake?: boolean, automatic?: boolean) => Promise<void>; cleanup: () => void };
  function message(overrides: Record<string, unknown> = {}) {
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: popup, origin: new URL(approval).origin, data: { type: "piik-app-approved", site }, ...overrides,
    }));
  }
  const activateElsewhere = () => { activated = true; window.dispatchEvent(new Event("activation")); };
  const openApproval = async () => { await operation.connect(); await operation.connect(); };
  return { ...operation, openApproval, popup, window, document, native, pending, help, showHelp, setState, setBuild, setManagement, activateClient, activateElsewhere, onConnected, message,
    get navigationIssue() { return navigationIssue; } };
}

it.each([
  ["unavailable", null],
  ["incompatible", null],
  ["unsupported", "unsupported"],
  ["popup-blocked", "popup-blocked"],
] as const)("resolves earlier navigation issue %s according to confirmed App readiness", (issue, expected) => {
  const page = mount(false, "ready", false, true, undefined, false, true, issue);
  try { expect(page.navigationIssue).toBe(expected); }
  finally { page.cleanup(); }
});

describe("App connection approval", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retires the verified management destination when health no longer confirms App", async () => {
    const page = mount(true, "ready");
    page.native.discoverNativeHealth.mockResolvedValue({ managementURL: "http://127.0.0.1:39721/client" });
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.setManagement).toHaveBeenLastCalledWith({ url: "http://127.0.0.1:39721/client", updateSupported: false });
    page.native.discoverNativeHealth.mockResolvedValue(null);
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.setManagement).toHaveBeenLastCalledWith(undefined);
    page.cleanup();
  });

  it.each([
    [false, false, "incompatible"],
    [true, false, "approval"],
    [true, true, "ready"],
  ] as const)("uses current App discovery beside public 2.x: current=%s authorized=%s => %s", async (current, authorized, state) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input), port = Number(url.port);
      if (port === NATIVE_CLIENT_PORT_START) return Response.json({ service: "piik-client", protocol: 10, port, instanceToken: "fixture-token" });
      if (current && port === NATIVE_CLIENT_PORT_START + 1) {
        const identity = { service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port };
        if (url.pathname === "/connect-discovery") return Response.json({ ...identity, connectURL: `http://127.0.0.1:${port}/client` });
        return authorized ? Response.json({ ...identity, token: "fixture-token" }) : new Response(null, { status: 403 });
      }
      throw new TypeError("No fixture App");
    }));
    const page = mount(false, "idle", false, undefined, channelAppDiscovery);
    try {
      await page.connect();
      expect(page.setState).toHaveBeenLastCalledWith(state);
      expect(page.window.open).not.toHaveBeenCalled();
      if (state === "approval") {
        await page.connect();
        expect(page.window.open).toHaveBeenCalledWith(`http://127.0.0.1:${NATIVE_CLIENT_PORT_START + 1}/client?site=http%3A%2F%2F127.0.0.1`, "_blank");
      }
    } finally { page.cleanup(); }
  });

  it("recognizes the current App and rejects an older channel protocol through the shared entry", async () => {
    const discovery = runInNewContext(ts.transpileModule(
      `function entry(${connectionProps}) { return discovery; } entry({});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText, { channelAppDiscovery }) as typeof channelAppDiscovery;
    expect(discovery).toBe(channelAppDiscovery);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1:8787/__status-preview") });
    let domainProtocol = CHANNEL_PROTOCOL;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const port = Number(new URL(input).port);
      if (port !== NATIVE_CLIENT_PORT_START) throw new TypeError("No fixture App");
      return Response.json({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol, port, token: "fixture-token" });
    }));
    await expect(discovery.health()).resolves.toMatchObject({ port: NATIVE_CLIENT_PORT_START });
    domainProtocol = CHANNEL_PROTOCOL - 1;
    await expect(discovery.health()).rejects.toThrow("incompatible_protocol");
  });

  it("keeps approval and subsequent management refresh on the App the user approved", async () => {
    const first = NATIVE_CLIENT_PORT_START;
    let approved = false;
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL(site) });
    vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) } });
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input), port = Number(url.port);
      if (port !== first && port !== first + 1) throw new TypeError("No fixture App");
      const identity = { service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port };
      if (url.pathname === "/connect-discovery") return Response.json({ ...identity, connectURL: `http://127.0.0.1:${port}/client` });
      if (!approved) return new Response(null, { status: 403 });
      if (port === first) await settle();
      return Response.json({ ...identity, token: "fixture-token" });
    });
    const page = mount(true, "idle", false, undefined, channelAppDiscovery);
    try {
      await page.openApproval();
      expect(page.window.open).toHaveBeenCalledWith(approval, "_blank");
      approved = true;
      page.message();
      await vi.waitFor(() => expect(page.onConnected).toHaveBeenCalledOnce());
      expect(page.onConnected.mock.calls[0]![0].port).toBe(first);
      const connectedPage = mount(true, "idle", false, true, channelAppDiscovery, false, true, null, first);
      try {
        await vi.waitFor(() => expect(connectedPage.setManagement).toHaveBeenCalled());
        expect(connectedPage.setManagement).toHaveBeenLastCalledWith({ url: `http://127.0.0.1:${first}/client`, updateSupported: false });
      } finally { connectedPage.cleanup(); }
    } finally { page.cleanup(); }
  });

  it("upgrades passive discovery to one user request and ignores the retired result", async () => {
    const page = mount();
    let complete!: (url: string | null) => void;
    page.native.discoverNativeConnect.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    page.native.discoverNativeHealth.mockResolvedValue({});
    const passive = page.connect(false, true);
    const old = page.pending.current!;
    await page.connect();
    expect(page.native.discoverNativeConnect.mock.calls.map(([options]) => options.waitForPermission)).toEqual([false, true]);
    expect(old.controller.signal.aborted).toBe(true);
    old.cancel!();
    complete(null);
    await passive;
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.onConnected).toHaveBeenCalledOnce();
    page.cleanup();
  });

  it("uses fresh authorized health instead of offering approval again", async () => {
    const page = mount();
    const health = { port: 39721, token: "approved" };
    page.native.discoverNativeHealth.mockResolvedValue(health);
    await page.connect();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.setState).not.toHaveBeenCalledWith("approval");
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledWith(health, expect.any(AbortSignal));
    expect(page.pending.current).toBeNull();
    page.cleanup();
  });

  it("wakes Android in the original tab, then resumes discovery and explicit approval on return", async () => {
    const page = mount(false, "idle", true);
    await page.connect(true);
    expect(page.window.location.assign).toHaveBeenCalledWith("intent://app#Intent;scheme=piik;package=tv.piik.android;end");
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.native.discoverNativeConnect).not.toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
    page.window.dispatchEvent(new Event("focus"));
    page.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(page.native.discoverNativeConnect).toHaveBeenCalledOnce();
    expect(page.setState).toHaveBeenLastCalledWith("approval");
    expect(page.window.open).not.toHaveBeenCalled();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledWith(approval, "_blank");
    page.message();
    await settle();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledTimes(2);
    expect(page.activateClient).toHaveBeenCalledOnce();
    page.cleanup();
  });

  it("cancels a cold wake without reviving discovery after a late App return", async () => {
    const page = mount(false, "idle", true);
    await page.connect(true);
    page.pending.current!.cancel!();
    page.window.dispatchEvent(new Event("focus"));
    page.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(page.native.discoverNativeConnect).not.toHaveBeenCalled();
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.pending.current).toBeNull();
    page.cleanup();
  });

  it("keeps permission discovery in the original tab and opens only on a later click", async () => {
    const page = mount();
    let complete!: (url: string) => void;
    page.native.discoverNativeConnect.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = page.connect();
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("busy");
    expect(page.showHelp).toHaveBeenCalledOnce();
    expect(page.window.open).not.toHaveBeenCalled();
    complete(approval);
    await connecting;
    expect(page.setState).toHaveBeenLastCalledWith("approval");
    expect(page.window.open).not.toHaveBeenCalled();
    page.message({ source: null });
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledWith(approval, "_blank");
    expect(page.setState).toHaveBeenLastCalledWith("approving");
    page.cleanup();
  });

  it("cancels dismissed discovery and ignores its late result before a retry", async () => {
    const page = mount();
    let complete!: (url: string) => void;
    page.native.discoverNativeConnect.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const connecting = page.connect();
    await settle();
    const first = page.pending.current!;
    first.cancel!();
    expect(first.controller.signal.aborted).toBe(true);
    expect(page.pending.current).toBeNull();
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    await page.connect();
    complete(approval);
    await connecting;
    expect(page.setState).toHaveBeenLastCalledWith("approval");
    expect(page.pending.current).not.toBe(first);
    expect(page.window.open).not.toHaveBeenCalled();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledOnce();
    page.cleanup();
  });

  it("reconnects an explicitly disconnected owner even while App health is ready", async () => {
    const page = mount(true, "ready", false, false);
    await page.connect();
    expect(page.native.discoverNativeHealth).toHaveBeenCalled();
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    page.cleanup();
  });

  it("offers recovery without activation or a stranded popup when no App is found", async () => {
    const page = mount();
    page.native.discoverNativeConnect.mockResolvedValue(null);
    await page.connect();
    expect(page.setState).toHaveBeenLastCalledWith("unavailable");
    expect(page.showHelp).toHaveBeenCalledTimes(2);
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.pending.current).toBeNull();
    expect(page.activateClient).not.toHaveBeenCalled();
    page.cleanup();
  });

  it("offers recovery when the browser blocks the approval window", async () => {
    const page = mount();
    page.window.open.mockReturnValue(null);
    await page.openApproval();
    expect(page.setState).toHaveBeenLastCalledWith("unavailable");
    expect(page.showHelp).toHaveBeenCalledTimes(2);
    expect(page.native.discoverNativeConnect).toHaveBeenCalledOnce();
    expect(page.activateClient).not.toHaveBeenCalled();
    page.cleanup();
  });

  it("requires the exact window, origin and site, then verifies App health once", async () => {
    const page = mount();
    await page.openApproval();
    page.native.discoverNativeHealth.mockClear();
    let complete!: (health: object) => void;
    page.native.discoverNativeHealth.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await page.connect();
    expect(page.window.open).toHaveBeenCalledOnce();
    expect(page.window.open).toHaveBeenCalledWith(approval, "_blank");
    for (const invalid of [
      { source: {} }, { origin: "http://127.0.0.1:39722" },
      { data: { type: "piik-app-approved", site: "https://another.example" } },
      { data: { type: "other", site } }, { data: null },
    ]) page.message(invalid);
    expect(page.native.discoverNativeHealth).not.toHaveBeenCalled();
    page.message();
    page.message();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
    expect(page.activateClient).not.toHaveBeenCalled();
    const health = { port: 39721, token: "approved-after-popup" };
    complete(health);
    await settle();
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledWith(health, expect.any(AbortSignal));
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.popup.closed).toBe(true);
    expect(page.pending.current).toBeNull();
    expect(page.native.discoverNativeConnect.mock.calls[0]![0].signal?.aborted).toBe(true);
    page.message();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
  });

  it.each(["absent", "failed"])("does not activate from an approval message when health is %s", async result => {
    const page = mount();
    await page.openApproval();
    if (result === "absent") page.native.discoverNativeHealth.mockResolvedValue(null);
    else page.native.discoverNativeHealth.mockRejectedValue(new Error("network unavailable"));
    page.message();
    await settle();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.onConnected).not.toHaveBeenCalled();
    expect(page.setState).toHaveBeenLastCalledWith("unavailable");
    expect(page.popup.closed).toBe(true);
    expect(page.pending.current).toBeNull();
    page.native.discoverNativeHealth.mockResolvedValue(null);
    await page.openApproval();
    expect(page.window.open).toHaveBeenCalledTimes(2);
    page.cleanup();
  });

  it("ignores a late healthy response after unmount and closes the popup", async () => {
    const page = mount();
    await page.openApproval();
    page.native.discoverNativeHealth.mockClear();
    let complete!: (health: object) => void;
    page.native.discoverNativeHealth.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    page.message();
    page.cleanup();
    complete({});
    await settle();
    page.message();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.onConnected).not.toHaveBeenCalled();
    expect(page.popup.closed).toBe(true);
    expect(page.native.discoverNativeHealth.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(page.setState).toHaveBeenLastCalledWith("approving");
  });

  it("never opens an approval page when discovery completes after unmount", async () => {
    const page = mount();
    let complete!: (url: string) => void;
    page.native.discoverNativeConnect.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = page.connect();
    await settle();
    page.cleanup();
    complete(approval);
    await connecting;
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
  });

  it("verifies authorization on return even when the approval message is unavailable", async () => {
    const page = mount();
    await page.openApproval();
    page.native.discoverNativeHealth.mockClear();
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.pending.current).toBeNull();
    page.cleanup();
  });

  it("releases an unapproved closed window on focus and permits retry", async () => {
    const page = mount();
    await page.openApproval();
    page.native.discoverNativeHealth.mockResolvedValue(null);
    page.popup.closed = true;
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.pending.current).toBeNull();
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    page.message();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledTimes(2);
    await page.openApproval();
    expect(page.window.open).toHaveBeenCalledTimes(2);
    page.cleanup();
  });

  it("reads App build metadata on return without downgrading a proven control connection", async () => {
    const page = mount(true, "ready", false, true);
    page.native.discoverNativeHealth.mockResolvedValue(null);
    await settle();
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.native.discoverNativeHealth).toHaveBeenCalledWith(expect.objectContaining({ waitForPermission: false }));
    expect(page.setBuild).toHaveBeenLastCalledWith(undefined);
    expect(page.native.discoverNativeConnect).not.toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.onConnected).not.toHaveBeenCalled();
    page.cleanup();
  });

  it("uses the approved App's build and drops credentials from the update input", async () => {
    const page = mount(true);
    const build = { version: "v2.5.1", revision: "a".repeat(40), packageTarget: "android-universal" };
    page.native.discoverNativeHealth.mockResolvedValue({ ...build, token: "local-secret" });
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.setBuild).toHaveBeenLastCalledWith(build);
    expect(page.setBuild.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ token: expect.anything() }));
    page.cleanup();
  });

  it("verifies remembered activation without prompting and refreshes it on return", async () => {
    const page = mount(true);
    await settle();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledWith(expect.objectContaining({ waitForPermission: false }));
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
    page.native.discoverNativeHealth.mockResolvedValue(null);
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    page.cleanup();
  });

  it("reflects another App entry's activation without needing a focus change", async () => {
    const page = mount();
    await settle();
    expect(page.native.discoverNativeHealth).not.toHaveBeenCalled();
    page.activateElsewhere();
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.window.open).not.toHaveBeenCalled();
    page.cleanup();
    page.activateElsewhere();
    await settle();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
  });

  it("does not let an earlier health check overwrite a newer approval", async () => {
    const page = mount(true);
    await settle();
    let complete!: (health: object | null) => void;
    page.native.discoverNativeHealth.mockClear().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    page.window.dispatchEvent(new Event("focus"));
    await settle();
    await page.openApproval();
    expect(page.native.discoverNativeHealth.mock.calls[0]![0].signal.aborted).toBe(true);
    page.message();
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    complete(null);
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    page.cleanup();
  });
});

describe("initial App discovery", () => {
  it.each([true, false])("checks site approval on explicit connection when loopback permission still says prompt (approved: %s)", async approved => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL(`${site}/`) });
    const permission = Object.assign(new EventTarget(), { state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query: vi.fn(async () => permission) } });
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input), port = Number(url.port);
      if (port !== NATIVE_CLIENT_PORT_START) throw new TypeError("No fixture App");
      const identity = { service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port };
      if (url.pathname === "/health") return approved ? Response.json({ ...identity, token: "fixture-token" }) : new Response(null, { status: 403 });
      return Response.json({ ...identity, connectURL: `http://127.0.0.1:${port}/client` });
    });
    vi.stubGlobal("fetch", fetcher);
    const page = mount(false, "idle", false, false, channelAppDiscovery, true);
    try {
      await settle();
      expect(fetcher).not.toHaveBeenCalled();
      expect(page.setState).toHaveBeenLastCalledWith("idle");
      expect(page.showHelp).not.toHaveBeenCalled();
      await page.connect();
      expect(page.setState).toHaveBeenLastCalledWith(approved ? "ready" : "approval");
      expect(page.onConnected).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(page.window.open).not.toHaveBeenCalled();
    } finally { page.cleanup(); vi.unstubAllGlobals(); }
  });

  it.each([false, true])("passive incompatibility stays quiet and preserves the live owner's connected fact (%s)", async connected => {
    const incompatible = new Error("incompatible");
    const discovery = { connect: vi.fn(async (): Promise<string | null> => { throw incompatible; }),
      health: vi.fn(async (): Promise<null> => { throw incompatible; }), isIncompatible: (error: unknown) => error === incompatible };
    const page = mount(true, "idle", false, connected, discovery);
    try {
      await settle();
      expect(page.setState).toHaveBeenLastCalledWith(connected ? "ready" : "idle");
      expect(page.showHelp).not.toHaveBeenCalled();
      expect(page.window.open).not.toHaveBeenCalled();
      if (!connected) {
        await page.connect();
        expect(page.setState).toHaveBeenLastCalledWith("incompatible");
        expect(page.showHelp).toHaveBeenCalled();
      }
    } finally { page.cleanup(); }
  });

  it("late automatic App readiness preserves a failed site's WebAssembly guidance", async () => {
    const pageSource = ts.createSourceFile("ChannelPreviewPage.tsx", readFileSync("src/client/pages/ChannelPreviewPage.tsx", "utf8"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback = "";
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(pageSource) === "onConnected" && node.initializer && ts.isJsxExpression(node.initializer))
        callback = node.initializer.expression!.getText(pageSource);
      ts.forEachChild(node, visit);
    };
    visit(pageSource);
    expect(callback).not.toBe("");
    class SiteSocket {
      static current: SiteSocket;
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => Promise<void>) | null = null;
      onclose: (() => void) | null = null;
      constructor() { SiteSocket.current = this; }
      send(data: string) { this.sent.push(data); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    vi.stubGlobal("WebAssembly", undefined);
    vi.stubGlobal("WebSocket", SiteSocket);
    vi.stubGlobal("location", new URL("https://owned.test/"));
    vi.stubGlobal("history", { state: null });
    const session = new ChannelSession();
    let ready!: (value: object) => void;
    const discovery = { connect: vi.fn(async () => approval), health: vi.fn(() => new Promise<object>(resolve => { ready = resolve; })), isIncompatible: () => false };
    const page = mount(false, "idle", false, false, discovery, true);
    const onConnected = runInNewContext(ts.transpileModule(`(${callback})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { channel: session });
    page.onConnected.mockImplementation(onConnected);
    try {
      session.start(); await SiteSocket.current.onopen?.(); await settle();
      expect(session.getSnapshot()).toMatchObject({ connection: "closed", error: "webassembly_unavailable" });
      const closedCommands = [...SiteSocket.current.sent];
      ready({}); await settle();
      expect(page.onConnected).toHaveBeenCalledOnce();
      expect(page.setState).toHaveBeenLastCalledWith("idle");
      expect(page.setState).not.toHaveBeenCalledWith("ready");
      expect(session.getSnapshot()).toMatchObject({ connection: "closed", error: "webassembly_unavailable" });
      expect(SiteSocket.current.sent).toEqual(closedCommands);
    } finally { page.cleanup(); session.close(); vi.unstubAllGlobals(); }
  });
  it("verifies an already approved App without opening another page", async () => {
    const discovery = { connect: vi.fn(async () => approval), health: vi.fn(async () => ({})), isIncompatible: () => false };
    const page = mount(false, "idle", false, false, discovery, true);
    await settle();
    expect(discovery.connect).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.showHelp).not.toHaveBeenCalled();
    page.cleanup();
  });
  it("waits for a real approval click instead of treating discovery as authorization", async () => {
    const discovery = { connect: vi.fn(async () => approval), health: vi.fn(async () => null), isIncompatible: () => false };
    const page = mount(false, "idle", false, false, discovery, true);
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("approval");
    expect(page.onConnected).not.toHaveBeenCalled();
    expect(page.window.open).not.toHaveBeenCalled();
    page.window.dispatchEvent(new Event("focus")); await settle();
    expect(discovery.connect).toHaveBeenCalledOnce();
    await page.connect(); expect(page.window.open).toHaveBeenCalledOnce(); page.cleanup();
  });
  it("finishes a waiting page's handshake when another page approves the site", async () => {
    const waiting = mount(false, "idle", false, false, undefined, true);
    const granting = mount();
    try {
      await settle();
      expect(waiting.setState).toHaveBeenLastCalledWith("approval");
      await granting.openApproval();
      granting.message();
      await settle();
      expect(granting.activateClient).toHaveBeenCalledOnce();

      waiting.native.discoverNativeHealth.mockResolvedValueOnce(null);
      waiting.activateElsewhere();
      await settle();
      expect(waiting.onConnected).not.toHaveBeenCalled();
      expect(waiting.setState).toHaveBeenLastCalledWith("approval");

      waiting.window.dispatchEvent(new Event("focus"));
      waiting.document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(waiting.native.discoverNativeHealth).toHaveBeenCalledTimes(3);
      expect(waiting.native.discoverNativeHealth).toHaveBeenLastCalledWith(expect.objectContaining({ waitForPermission: false }));
      expect(waiting.onConnected).toHaveBeenCalledOnce();
      expect(waiting.setState).toHaveBeenLastCalledWith("ready");
      expect(waiting.window.open).not.toHaveBeenCalled();
    } finally { granting.cleanup(); waiting.cleanup(); }
  });
  it("stops failed discovery across focus, permits manual retry, and aborts on unmount", async () => {
    const discovery = { connect: vi.fn(async (_options?: AppDiscoveryOptions): Promise<string | null> => null), health: vi.fn(async () => ({})), isIncompatible: () => false };
    const page = mount(true, "idle", false, false, discovery, true);
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    expect(page.showHelp).not.toHaveBeenCalled();
    page.window.dispatchEvent(new Event("focus")); page.activateElsewhere(); await settle();
    expect(discovery.connect).toHaveBeenCalledOnce(); expect(discovery.health).not.toHaveBeenCalled();
    let signal: AbortSignal | undefined;
    discovery.connect.mockImplementationOnce(value => { signal = value?.signal; return new Promise(() => {}); });
    void page.connect(); expect(discovery.connect).toHaveBeenCalledTimes(2);
    page.cleanup(); expect(signal?.aborted).toBe(true);
  });
  it.each([false, true])("automatic discovery stays idle; explicit failure keeps recovery guidance (incompatible: %s)", async incompatible => {
    const discovery = { connect: vi.fn(async (): Promise<string | null> => { if (incompatible) throw new Error("incompatible"); return null; }),
      health: vi.fn(async () => null), isIncompatible: () => incompatible };
    const page = mount(false, "idle", false, false, discovery, true);
    try {
      await settle();
      expect(page.setState).toHaveBeenLastCalledWith("idle");
      expect(page.showHelp).not.toHaveBeenCalled();
      await page.connect();
      expect(page.setState).toHaveBeenLastCalledWith(incompatible ? "incompatible" : "unavailable");
      expect(page.showHelp).toHaveBeenCalled();
    } finally { page.cleanup(); }
  });
  it("an explicit approval click takes over the automatic attempt's failure feedback", async () => {
    const discovery = { connect: vi.fn(async () => approval), health: vi.fn(async () => null), isIncompatible: () => false };
    const page = mount(false, "idle", false, false, discovery, true);
    try {
      await settle();
      expect(page.setState).toHaveBeenLastCalledWith("approval");
      page.window.open.mockReturnValue(null);
      await page.connect();
      expect(page.setState).toHaveBeenLastCalledWith("unavailable");
      expect(page.showHelp).toHaveBeenCalled();
    } finally { page.cleanup(); }
  });
});


it("keeps forwarding settings reachable for main playback with a retained Page source", () => {
  setCopy({ lang: "en" });
  const source = { sessionId: "provider", resourceId: "root", format: "hls" };
  const activity = { id: "watch", roomId: "room", sessionId: "self", byteSource: source as typeof source | null };
  const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: true, sessionId: "self",
    pending: new Set(), browserCapturePreparation: () => undefined, nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined, externalInput: () => undefined,
    state: { publications: [], voice: [], watchActivities: [activity] },
    watchPlayers: new Map([["watch", { video: {}, media: { page: {}, retainedByteSource: source } }]]),
  } as unknown as ChannelController;
  const render = () => {
    vi.mocked(useState).mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([true, vi.fn()]);
    return renderToStaticMarkup(createElement(ChannelShareControl, { onWatch() {}, channel, roomId: "room", disabled: false }));
  };
  expect(render()).toContain('aria-label="Stop forwarding"');
  activity.byteSource = null;
  const html = render();
  expect(html).toContain('aria-label="Share settings"');
  expect(html).toContain('aria-label="Resume forwarding this video"');
  expect(html).not.toContain('aria-label="Choose video to forward"');
});


describe("App control handshake uses the existing approval attempt", () => {
  it("keeps automatic handshake busy and cancellable, fences its late completion, then retries", async () => {
    const page = mount(true, "idle", false, false);
    let complete!: () => void;
    page.onConnected.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const first = page.connect(false, true);
    await settle();
    const attempt = page.pending.current!;
    expect(page.setState).toHaveBeenLastCalledWith("busy");
    await page.connect();
    expect(page.showHelp).toHaveBeenCalled();
    expect(page.activateClient).not.toHaveBeenCalled();
    attempt.cancel!();
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    await page.connect();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    complete(); await first;
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledTimes(2);
    page.cleanup();
  });

  it.each([false, true])("owns handshake failure feedback for automatic=%s", async automatic => {
    const page = mount(true, "idle", false, false);
    page.onConnected.mockRejectedValueOnce(new Error("app_disconnected"));
    await page.connect(false, automatic);
    expect(page.setState).toHaveBeenLastCalledWith(automatic ? "idle" : "unavailable");
    expect(page.showHelp.mock.calls.length > 0).toBe(!automatic);
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.pending.current).toBeNull();
    page.cleanup();
  });
});


it("keeps App control unavailable until the owning Site is admitted", async () => {
  const page = mount(true, "idle", false, false, undefined, true, false);
  await settle();
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  expect(page.native.discoverNativeConnect).not.toHaveBeenCalled();
  expect(page.onConnected).not.toHaveBeenCalled();
  await page.connect();
  expect(page.native.discoverNativeConnect).not.toHaveBeenCalled();
  page.cleanup();
});

it("uses the same automatic attempt on activated return and does not restart it after cancel", async () => {
  const page = mount(true, "idle", false, false);
  let complete!: () => void;
  page.onConnected.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  page.window.dispatchEvent(new Event("focus"));
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  expect(page.onConnected).toHaveBeenCalledOnce();
  page.pending.current!.cancel!();
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  expect(page.onConnected).toHaveBeenCalledOnce();
  complete(); await settle();
  expect(page.activateClient).not.toHaveBeenCalled();
  page.cleanup();
});

it("keeps source enumeration failures distinct from access denial and App recovery", () => {
  setCopy({ lang: "en" });
  const render = (nativeSources: Parameters<typeof CaptureSourcePicker>[0]["nativeSources"]) =>
    renderToStaticMarkup(createElement(CaptureSourcePicker, {
      nativeSources, initialTab: "window", browserSupported: true,
      onBrowser: vi.fn(), onNative: vi.fn(), onPreview: async () => null,
      onRefresh: vi.fn(), nativeFailureMessage: nativeSources.kind === "failed" ? channelErrorPresentation(nativeSources.error ?? null, (key, vars) => t("en", key, vars), "host.sourcePicker.failed").message ?? undefined : undefined, onCancel: vi.fn(),
    }));
  expect(render({ kind: "failed", error: "portal_failed" })).toContain(t("en", "host.sourcePicker.failed"));
  expect(render({ kind: "failed", error: "permission_denied" })).toContain(t("en", "channel.error.deviceAccessDenied"));
  const timedOut = render({ kind: "failed", error: "app_request_timeout" });
  expect(timedOut).toContain(t("en", "native.fail.requestTimeout"));
  expect(timedOut).toMatch(new RegExp(`aria-label="${t("en", "host.sourcePicker.refresh")}"(?![^>]*disabled)`));
  const unavailable = render({ kind: "unavailable" });

  expect(unavailable).not.toContain(t("en", "host.sourcePicker.failed"));
});
