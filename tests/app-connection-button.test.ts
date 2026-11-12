import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ChannelSession } from "../src/client/channel/session";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConnectionButton } from "../src/client/components/living/AppConnectionButton";
import { CaptureSourcePicker } from "../src/client/components/living/CaptureSourcePicker";
import { ChannelShareControl } from "../src/client/channel/components/ChannelShareControl";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import type { ChannelController } from "../src/client/channel/types";
import { setCopy, t } from "../src/client/ui/copy";
import { channelAppDiscovery } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { NATIVE_CLIENT_PORT_START } from "../src/client/native/discovery-ports";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

describe("shared App connection entry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an unconnected owner discoverable even after App permission is verified", () => {
    setCopy({ lang: "en", vis: false });
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
    { camera: true, display: false, available: true, picker: true },
    { camera: true, display: true, available: true, picker: true },
    { camera: false, display: true, available: true, picker: false },
    { camera: false, display: false, available: false, picker: false },
  ])("uses actual camera/display capability for the single channel sharing entry ($camera/$display)", entry => {
    vi.stubGlobal("navigator", { mediaDevices: {
      ...(entry.camera ? { getUserMedia: vi.fn() } : {}),
      ...(entry.display ? { getDisplayMedia: vi.fn() } : {}),
    } });
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: false, pending: new Set(), nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "room", disabled: false }));
    const button = html.match(/<button\b[^>]*>/)![0];
    expect(button.includes("disabled")).toBe(!entry.available);
    expect(button.toLowerCase().includes("popovertarget=")).toBe(entry.picker);
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="(?:Share settings|分享设置)"/);
  });
  it("binds live controls to their owned publication without retargeting a retired source", () => {
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn() } });
    const ownedScreens = new Set(["mine"]);
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: false, pending: new Set(), nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined,
      screenQuality: () => undefined, screenCodecMode: () => undefined,
      sourceAudio: () => undefined, sourceMicrophone: () => undefined,
      ownedScreens, streams: new Map(), state: { channel: { rooms: [{ id: "room", name: "Friday" }] }, publications: [{ id: "mine", roomId: "room" }], voice: [] },
    } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "room", publicationId: "mine", compact: true, disabled: false }));
    expect(html).toMatch(/aria-label="(?:Switch source in Friday|切换Friday的分享源)"/);
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="(?:Share settings in Friday|Friday的分享设置)"/);
    const elsewhere = renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "other", disabled: false }));
    expect(elsewhere).not.toMatch(/aria-label="(?:Switch source|切换来源)"/);
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "other", publicationId: "mine", disabled: false }))).toBe("");
    ownedScreens.clear();
    expect(renderToStaticMarkup(createElement(ChannelShareControl, { channel, roomId: "room", publicationId: "mine", disabled: false }))).toBe("");
  });
});

describe("Native sharing capabilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives Native availability from retained capabilities and the source's codec mode", () => {
    setCopy({ lang: "en", vis: false });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn(), getUserMedia: vi.fn() } });
    const sources = { kind: "ready", codecs: ["h264"], processAudio: false, systemAudio: false,
      sources: [{ kind: "window", sourceId: "1", title: "Owned Native window", pid: 1, creationTime: "1" }] };
    const channel = { quality: DEFAULT_QUALITY_SETTINGS, setQuality: vi.fn(), appConnected: true, pending: new Set(),
      videoCodecMode: "vp8", nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined,
      screenQuality: () => undefined, screenCodecMode: () => "h264", sourceAudio: () => undefined, sourceMicrophone: () => undefined,
      ownedScreens: new Set<string>(), streams: new Map(), state: { channel: { rooms: [{ id: "room", name: "Friday" }] }, publications: [] as { id: string; roomId: string }[], voice: [] },
    };
    const render = (settings = false) => {
      // Open the real picker with the same completed targets response on each render.
      vi.mocked(useState).mockReturnValueOnce([!settings, vi.fn()]).mockReturnValueOnce([settings, vi.fn()])
        .mockReturnValueOnce([sources, vi.fn()]);
      return renderToStaticMarkup(createElement(ChannelShareControl, { channel: channel as unknown as ChannelController,
        roomId: "room", publicationId: channel.ownedScreens.has("mine") ? "mine" : undefined, disabled: false }));
    };
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
    channel.state.publications.push({ id: "mine", roomId: "room" });
    channel.ownedScreens.add("mine");
    channel.videoCodecMode = "vp8";
    const sharing = render(true);
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
const executable = ts.transpileModule(`${rememberBuild}\n${connect}\nconst cleanups = [${effects.map(effect => effect.includes("connect(false, true)") ? `(automatic ? (${effect})() : undefined)` : `(${effect})()`).join(",")}];
  ({ connect, cleanup: () => { cleanups.reverse().forEach(fn => fn?.()); pending.current?.controller.abort(); pending.current?.popup?.close(); } });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const site = "https://site.example";
const approval = `http://127.0.0.1:39721/client?site=${encodeURIComponent(site)}`;

function mount(activated = false, state: "idle" | "ready" = "idle", android = false, connected?: boolean, discovery?: typeof channelAppDiscovery, automatic = false) {
  const popup = { closed: false, close: vi.fn(() => { popup.closed = true; }) };
  const window = Object.assign(new EventTarget(), { open: vi.fn((): typeof popup | null => popup), location: { origin: site, assign: vi.fn() } });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const native = {
    discoverNativeConnect: vi.fn(async (_signal: AbortSignal): Promise<string | null> => approval),
    discoverNativeHealth: vi.fn(async (options: { signal: AbortSignal; waitForPermission?: boolean }): Promise<object | null> =>
      options.waitForPermission === false && !activated ? null : {}),
    NativeCompatibilityError: class extends Error {},
  };
  const pending = { current: null as { controller: AbortController; cancel?: () => void } | null };
  const healthCheck = { current: null as AbortController | null };
  const help = { current: { hidePopover: vi.fn(), matches: vi.fn(() => false) } };
  const showHelp = vi.fn();
  const setState = vi.fn();
  const setBuild = vi.fn();
  const activateClient = vi.fn();
  const onConnected = vi.fn();
  const operation = runInNewContext(executable, {
    automatic, automaticFailed: { current: false }, window, document, pending, healthCheck, help, showHelp, setState, setAutomaticHint: vi.fn(), setBuild, activateClient, onConnected, AbortController, URL,
    wakeURL: android ? "intent://app#Intent;scheme=piik;package=tv.piik.android;end" : null,
    state, connected, isClientActivated: () => activated,
    discovery: discovery ?? { health: native.discoverNativeHealth, connect: native.discoverNativeConnect,
      isIncompatible: (error: unknown) => error instanceof native.NativeCompatibilityError },
    watchClientActivation: (changed: () => void) => {
      window.addEventListener("activation", changed);
      return () => window.removeEventListener("activation", changed);
    },
  }) as { connect: (wake?: boolean) => Promise<void>; cleanup: () => void };
  function message(overrides: Record<string, unknown> = {}) {
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: popup, origin: new URL(approval).origin, data: { type: "piik-app-approved", site }, ...overrides,
    }));
  }
  const activateElsewhere = () => { activated = true; window.dispatchEvent(new Event("activation")); };
  const openApproval = async () => { await operation.connect(); await operation.connect(); };
  return { ...operation, openApproval, popup, window, document, native, pending, help, showHelp, setState, setBuild, activateClient, activateElsewhere, onConnected, message };
}

describe("App connection approval", () => {
  afterEach(() => vi.unstubAllGlobals());

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
        const identity = { service: "piik-channel-app", protocol: 7, domainProtocol: CHANNEL_PROTOCOL, port };
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

  it("recognizes the current App through the shared entry's default discovery", async () => {
    const discovery = runInNewContext(ts.transpileModule(
      `function entry(${connectionProps}) { return discovery; } entry({});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText, { channelAppDiscovery }) as typeof channelAppDiscovery;
    expect(discovery).toBe(channelAppDiscovery);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1:8787/__status-preview") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const port = Number(new URL(input).port);
      if (port !== NATIVE_CLIENT_PORT_START) throw new TypeError("No fixture App");
      return Response.json({ service: "piik-channel-app", protocol: 7, domainProtocol: CHANNEL_PROTOCOL, port, token: "fixture-token" });
    }));
    await expect(discovery.health()).resolves.toMatchObject({ port: NATIVE_CLIENT_PORT_START });
  });

  it("uses fresh authorized health instead of offering approval again", async () => {
    const page = mount();
    page.native.discoverNativeHealth.mockResolvedValue({});
    await page.connect();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.setState).not.toHaveBeenCalledWith("approval");
    expect(page.window.open).not.toHaveBeenCalled();
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
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

  it("opens the launcher for an already connected Site without changing approval", async () => {
    const page = mount(true, "ready");
    await page.connect();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.setState).not.toHaveBeenCalledWith("approval");
    await page.connect();
    expect(page.window.open).toHaveBeenCalledWith("http://127.0.0.1:39721/client", "_blank");
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.pending.current).toBeNull();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.onConnected).not.toHaveBeenCalled();
    page.cleanup();
    expect(page.popup.closed).toBe(false);
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
    complete({});
    await settle();
    expect(page.activateClient).toHaveBeenCalledOnce();
    expect(page.onConnected).toHaveBeenCalledOnce();
    expect(page.setState).toHaveBeenLastCalledWith("ready");
    expect(page.popup.closed).toBe(true);
    expect(page.pending.current).toBeNull();
    expect(page.native.discoverNativeConnect.mock.calls[0]![0].aborted).toBe(true);
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
      expect(page.setState).toHaveBeenLastCalledWith("ready");
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
  it("stops failed discovery across focus, permits manual retry, and aborts on unmount", async () => {
    const discovery = { connect: vi.fn(async (_signal?: AbortSignal): Promise<string | null> => null), health: vi.fn(async () => ({})), isIncompatible: () => false };
    const page = mount(true, "idle", false, false, discovery, true);
    await settle();
    expect(page.setState).toHaveBeenLastCalledWith("unavailable");
    expect(page.showHelp).not.toHaveBeenCalled();
    page.window.dispatchEvent(new Event("focus")); page.activateElsewhere(); await settle();
    expect(discovery.connect).toHaveBeenCalledOnce(); expect(discovery.health).not.toHaveBeenCalled();
    let signal: AbortSignal | undefined;
    discovery.connect.mockImplementationOnce(value => { signal = value; return new Promise(() => {}); });
    void page.connect(); expect(discovery.connect).toHaveBeenCalledTimes(2);
    page.cleanup(); expect(signal?.aborted).toBe(true);
  });
});
