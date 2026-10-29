import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConnectionButton } from "../src/client/components/living/AppConnectionButton";
import { CaptureSourcePicker } from "../src/client/components/living/CaptureSourcePicker";

describe("shared App connection entry", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});

// Exercise the button's actual operation and unmount effect without a Browser.
// Discovery has separate transport tests; this covers who may activate a page.
const source = ts.createSourceFile("AppConnectionButton.tsx", readFileSync(
  new URL("../src/client/components/living/AppConnectionButton.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let connect: string | undefined;
const effects: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "connect") connect = node.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    effects.push(node.arguments[0]!.getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!connect || !effects.length) throw new Error("Missing App connection operation or cleanup");
const executable = ts.transpileModule(`${connect}\nconst cleanups = [${effects.map(effect => `(${effect})()`).join(",")}];
  ({ connect, cleanup: () => cleanups.reverse().forEach(fn => fn?.()) });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const site = "https://site.example";
const approval = `http://127.0.0.1:39721/client?site=${encodeURIComponent(site)}`;

function mount(activated = false, state: "idle" | "ready" = "idle", android = false) {
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
  const activateClient = vi.fn();
  const onConnected = vi.fn();
  const operation = runInNewContext(executable, {
    window, document, pending, healthCheck, help, showHelp, setState, activateClient, onConnected, AbortController, URL,
    wakeURL: android ? "intent://app#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end" : null,
    state, isClientActivated: () => activated,
    watchClientActivation: (changed: () => void) => {
      window.addEventListener("activation", changed);
      return () => window.removeEventListener("activation", changed);
    },
    require: (path: string) => {
      if (path !== "../../native/client") throw new Error(`Unexpected dependency: ${path}`);
      return native;
    },
  }) as { connect: (wake?: boolean) => Promise<void>; cleanup: () => void };
  function message(overrides: Record<string, unknown> = {}) {
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: popup, origin: new URL(approval).origin, data: { type: "silip-app-approved", site }, ...overrides,
    }));
  }
  const activateElsewhere = () => { activated = true; window.dispatchEvent(new Event("activation")); };
  const openApproval = async () => { await operation.connect(); await operation.connect(); };
  return { ...operation, openApproval, popup, window, document, native, pending, help, showHelp, setState, activateClient, activateElsewhere, onConnected, message };
}

describe("App connection approval", () => {
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
    expect(page.window.location.assign).toHaveBeenCalledWith("intent://app#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end");
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
      { data: { type: "silip-app-approved", site: "https://another.example" } },
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
    let complete!: (health: object | null) => void;
    page.native.discoverNativeHealth.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
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
