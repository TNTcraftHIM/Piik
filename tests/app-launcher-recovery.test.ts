import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LauncherForm, type LocalCertificate } from "../src/client/components/living/LauncherForm";
import { Btn } from "../src/client/components/living/primitives";
import { siteEntryOrigin, siteEntryURL } from "../src/client/lib/site-address";
import { clientLaunchURL, readPreferredAppMode, savePreferredAppMode, type AppMode } from "../src/client/lib/app-launch";
import { appUpdateSchema } from "../src/client/lib/use-app-update";

it("reloads the installed UI once after observed installation hands over, while failures and outages preserve the page", async () => {
  const updateSource = ts.createSourceFile("use-app-update.ts", readFileSync(
    new URL("../src/client/lib/use-app-update.ts", import.meta.url), "utf8",
  ), ts.ScriptTarget.Latest, true);
  const hook = updateSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useAppUpdate")!;
  const code = ts.transpileModule(`${hook.getText(updateSource).replace(/^export /, "")}\nuseAppUpdate();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const state of ["idle", "unavailable", "failed"] as const) {
    const reload = vi.fn();
    const window = Object.assign(new EventTarget(), { location: { reload } });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ state: "installing", operationId: "original-install" }))
      .mockRejectedValueOnce(new Error("App is restarting"))
      .mockResolvedValue(Response.json(state === "failed" ? { state, operationId: "original-install" } : { state }));
    let cleanup: (() => void) | undefined;
    let timer: (() => void) | undefined;
    const views: unknown[] = [];
    let stateSlot = 0;
    runInNewContext(code, {
      appUpdateSchema, fetch, window, AbortController,
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, stateSlot++ === 0 ? (view: unknown) => views.push(view) : () => {}],
      useEffect: (effect: () => () => void) => { cleanup = effect(); },
      setTimeout: (callback: () => void) => { timer = callback; return 1; },
      clearTimeout: () => { timer = undefined; },
    });
    await settle();
    expect(reload).not.toHaveBeenCalled();
    timer!(); await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(views).toEqual([{ state: "installing", operationId: "original-install" }]);
    expect(timer).toBeDefined();
    timer!(); await settle();
    expect(reload).toHaveBeenCalledTimes(state === "failed" ? 0 : 1);
    fetch.mockResolvedValue(Response.json({ state: "idle" }));
    window.dispatchEvent(new Event("focus")); await settle();
    expect(reload).toHaveBeenCalledTimes(state === "failed" ? 0 : 1);
    cleanup!();
  }
});

// Run the page's actual state-read effect, including cleanup, without a DOM.
const source = ts.createSourceFile("AppLauncherPage.tsx", readFileSync(
  new URL("../src/client/pages/AppLauncherPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: string[] = [];
let effect: string | undefined;
let diagnosticControl: string | undefined;
let modeInitializer: string | undefined;
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "[mode, setMode]"
    && node.initializer && ts.isCallExpression(node.initializer)) modeInitializer = node.initializer.arguments[0]?.getText(source);
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "diagnosticControl"
    && node.initializer && ts.isJsxExpression(node.initializer)) {
    diagnosticControl = node.initializer.expression!.getText(source);
  }
  if (ts.isVariableDeclaration(node) && /^(?:launcher.*|localCertificate)Schema$/.test(node.name.getText(source))) {
    declarations.push(`const ${node.getText(source)};`);
  }
  if (ts.isFunctionDeclaration(node) && ["beginStateChange", "changeMode", "changeSite", "approveSite", "enableDebug", "exportDebug", "launchURL", "launch"].includes(node.name?.text ?? "")) {
    declarations.push(node.getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[1]?.getText(source) === "[reload]") {
    effect = node.arguments[0]!.getText(source);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!effect) throw new Error("Missing App launcher state-read owner");
if (!diagnosticControl) throw new Error("Missing App launcher diagnostic control");
if (!modeInitializer) throw new Error("Missing App launcher mode initializer");
const diagnosticExecutable = ts.transpileModule(`(${diagnosticControl})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const executable = ts.transpileModule(`${declarations.join("\n")}\n({cleanup: (${effect})(), changeMode, changeSite, approveSite, enableDebug, exportDebug, launch});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const saved = {
  sites: ["https://site.example"], startupSite: "",
  revision: "test", version: "development", debug: false, sitePort: 8787,
  lan: { addresses: [{ address: "192.0.2.1", name: "LAN" }], selected: "192.0.2.1" },
};
const response = (state: typeof saved & { detail?: string; target?: string; localCertificate?: LocalCertificate } = saved) => ({ ok: true, status: 200, json: async () => state });

function mount(fetch: ReturnType<typeof vi.fn>, manualSite = false, { debug = false, mode, startup = false }: { debug?: boolean; mode?: AppMode; startup?: boolean } = {}) {
  const downloads = vi.fn();
  const initialMode = mode ?? runInNewContext(`(${modeInitializer})()`, { readPreferredAppMode }) as AppMode;
  const state: Record<string, unknown> = { Mode: initialMode };
  // Keep assertions about the rendered facts while the page owns one snapshot.
  for (const [name, field] of Object.entries({ ControlPort: "controlPort", Target: "target",
    LocalCertificate: "localCertificate", Sites: "sites", StartupSite: "startupSite",
    StartupMode: "startupMode", OwnedSites: "ownedSites", AppDebug: "debug" })) {
    Object.defineProperty(state, name, { get: () => {
      const value = (state.ServerState as Record<string, unknown> | undefined)?.[field];
      return name === "StartupMode" ? value || undefined : value;
    } });
  }
  Object.defineProperty(state, "Build", { get: () => state.ServerState });
  Object.defineProperty(state, "Lan", { get: () => {
    const lan = (state.ServerState as typeof saved | undefined)?.lan;
    return lan && { ...lan, selected: state.LanAddress ?? lan.selected };
  } });
  Object.defineProperty(state, "Starting", { get: () => (state.Error as { kind?: string } | null)?.kind !== "load"
    && (state.Launching === true || (state.ServerState as { starting?: boolean } | undefined)?.starting === true) });
  const setters = Object.fromEntries([
    "Mode", "LanAddress", "ServerState", "Launching", "Error", "Loading",
    "SiteBusy", "SiteError", "DebugBusy", "DebugError", "Reload",
  ].map(name => [`set${name}`, vi.fn((value: unknown) => {
    state[name] = typeof value === "function" ? value(state[name]) : value;
  })]));
  const window = Object.assign(new EventTarget(), { location: { replace: vi.fn(), search: startup ? "?start=1" : "" } });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const actions = runInNewContext(executable, {
    ...setters, z, fetch, window, URLSearchParams, AbortController, downloadBlob: downloads,
    stateChanges: { current: { revision: 0, pending: 0 } },
    siteBusy: false, debugBusy: false, starting: false, sites: saved.sites, manualSite, openOnApproval: false,
    mode: initialMode, lang: "en", vis: false, appDebug: debug, lan: saved.lan, sitePort: saved.sitePort, savePreferredAppMode,
    consoleLanguage: () => "en", clientLaunchURL, currentThemePreference: () => null, hasCopyPreference: () => false,
    controlPort: undefined, t: (key: string) => key,
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }) as { cleanup(): void; changeMode(mode: AppMode): void; changeSite(site: string, setting?: "site" | "startup-site", starAfterApproval?: boolean, allowed?: boolean): Promise<boolean>; approveSite(site: string): Promise<void>; enableDebug(): Promise<void>; exportDebug(): Promise<void>; launch(event: { preventDefault(): void }): Promise<void> };
  return { state, setters, ...actions, downloads, navigate: window.location.replace, focus: () => window.dispatchEvent(new Event("focus")),
    retry: () => {
      const entry = [...timers].find(([, timer]) => timer.delay === 750);
      expect(entry).toBeDefined();
      const [id, { callback }] = entry!;
      timers.delete(id);
      callback();
    },
    expireRequest: () => {
      const entry = [...timers].find(([, timer]) => timer.delay > 750);
      expect(entry).toBeDefined();
      const [id, { callback }] = entry!;
      timers.delete(id);
      callback();
    },
  };
}

describe("App launcher state recovery", () => {
  it("replaces a failed launch response with the running App's state on return", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(saved))
      .mockRejectedValueOnce(new Error("Startup response disconnected"));
    const page = mount(fetch);
    try {
      await settle();
      await page.launch({ preventDefault() {} });
      expect(page.state.Error).toEqual({ kind: "launch" });
      const localCertificate = { origin: "https://192.0.2.1:8791", sha256Fingerprint: "a".repeat(64) };
      fetch.mockResolvedValueOnce(response({ ...saved, target: "http://127.0.0.1:8791/", localCertificate }));
      page.focus(); await settle();
      expect(page.state).toMatchObject({ Target: "http://127.0.0.1:8791/", LocalCertificate: localCertificate, Starting: false, Error: null });
      expect(page.navigate).not.toHaveBeenCalled();
    } finally { page.cleanup(); }
  });
  it("restores explicit Browser mode choices on reload while running-state reads never save a preference", async () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem } });
    const fetch = vi.fn(async () => response({ ...saved, target: "https://running.example" }));
    try {
      const first = mount(fetch); await settle();
      expect(first.state.Mode).toBe("link"); expect(setItem).not.toHaveBeenCalled();
      first.changeMode("local"); first.cleanup();
      const local = mount(fetch); await settle();
      expect(local.state).toMatchObject({ Mode: "local", Target: "https://running.example" });
      local.focus(); await settle();
      expect(setItem).toHaveBeenCalledTimes(1); expect(local.state.Mode).toBe("local");
      local.changeMode("link"); local.cleanup();
      const link = mount(fetch); await settle();
      expect(link.state.Mode).toBe("link"); expect(setItem).toHaveBeenCalledTimes(2);
      link.cleanup();
    } finally { vi.unstubAllGlobals(); }
  });
  it("launches with diagnostics enabled without sending its process flag to the room command", async () => {
    const target = "http://127.0.0.1:41234/#piik-client=1";
    const fetch = vi.fn(async () => response({ ...saved, debug: true }));
    const page = mount(fetch, false, { debug: true, mode: "local" });
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:39722/client" } });
    try {
      await settle();
      expect(page.state.AppDebug).toBe(true);
      fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ target }) } as ReturnType<typeof response>);
      await page.launch({ preventDefault() {} });
      const [path, request] = fetch.mock.calls.at(-1)! as unknown as [string, { body: string }];
      expect(path).toBe("/api/client-launcher/launch");
      expect(JSON.parse(request.body)).toEqual({ mode: "local", port: saved.sitePort, language: "en", lanAddress: saved.lan.selected });
      const destination = new URL(page.navigate.mock.calls[0]![0] as string);
      expect(destination.origin).toBe(new URL(target).origin);
      expect(destination.searchParams.get("debug")).toBe("1");
      expect(new URLSearchParams(destination.hash.slice(1)).get("piik-client")).toBe("1");
    } finally {
      page.cleanup();
      vi.unstubAllGlobals();
    }
  });
  it("enables App diagnostics while its existing domain is running without navigating", async () => {
    const fetch = vi.fn(async () => response({ ...saved, target: "https://room.example" }));
    const page = mount(fetch);
    await settle();
    const control = runInNewContext(diagnosticExecutable, {
      React: { createElement }, Btn, appDebug: false, debug: false, debugBusy: false,
      loading: false, starting: true, target: page.state.Target, error: null,
      enableDebug: page.enableDebug, exportDebug: page.exportDebug,
    }) as ReactElement<{ onClick(): void }>;
    expect(renderToStaticMarkup(control)).not.toContain("disabled");
    control.props.onClick();
    await settle();
    expect(fetch).toHaveBeenLastCalledWith("/api/client-launcher/debug", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(page.state.AppDebug).toBe(true);
    expect(page.state.Target).toBe("https://room.example");
    expect(page.navigate).not.toHaveBeenCalled();
    page.cleanup();
  });
  it("retries an explicit App ZIP export without navigating or changing launcher state", async () => {
    const fetch = vi.fn(async () => response({ ...saved, debug: true }));
    const page = mount(fetch);
    await settle();
    fetch.mockResolvedValueOnce({ ok: false } as ReturnType<typeof response>);
    await page.exportDebug();
    expect(page.state.DebugError).toBe(true);
    expect(page.downloads).not.toHaveBeenCalled();
    const blob = new Blob(["fixture ZIP"], { type: "application/zip" });
    fetch.mockResolvedValueOnce({ ok: true, blob: async () => blob } as unknown as ReturnType<typeof response>);
    await page.exportDebug();
    expect(fetch).toHaveBeenLastCalledWith("/api/client-launcher/debug/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(page.downloads).toHaveBeenCalledWith(blob, expect.stringMatching(/^piik-app-.*\.zip$/));
    expect(page.state.AppDebug).toBe(true);
    expect(page.state.DebugError).toBe(false);
    expect(page.state.DebugBusy).toBe(false);
    expect(page.navigate).not.toHaveBeenCalled();
    page.cleanup();
  });
  it("uses the installed build identity without retaining a second presentation state", async () => {
    const revision = "a".repeat(40);
    const localCertificate = { origin: "https://192.0.2.1:8787", sha256Fingerprint: "A1".repeat(32) };
    const fetch = vi.fn(async () => response({ ...saved, version: "development", revision, localCertificate }));
    const page = mount(fetch);
    await settle();
    expect(page.state.Build).toMatchObject({ version: "development", revision });
    expect(page.state.LocalCertificate).toEqual(localCertificate);
    fetch.mockResolvedValueOnce(response(saved));
    page.focus(); await settle();
    expect(page.state.LocalCertificate).toBeUndefined();
    page.cleanup();
  });

  it("shows a failed Enter attempt and navigates after its retry succeeds", async () => {
    type Result = { ok: boolean; status: number; json(): Promise<unknown> };
    const fetch = vi.fn(async (): Promise<Result> => response());
    const page = mount(fetch);
    await settle();
    let finish!: (value: Result) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const event = { preventDefault() {} };
    const first = page.launch(event);
    expect(fetch).toHaveBeenCalledTimes(2); // Initial state and launch.
    finish({ ok: false, status: 503, json: async () => ({ detail: "Startup failed" }) });
    await first;
    expect(page.state).toMatchObject({ Starting: false, Error: { kind: "launch", detail: "Startup failed" } });
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ target: "https://room.example/#piik-client=1",
      localCertificate: { origin: "https://192.0.2.1:8787", sha256Fingerprint: "A1".repeat(32) } }) });
    await page.launch(event);
    expect(page.navigate).toHaveBeenCalledWith("https://room.example/#piik-client=1&piik-lang=en&piik-mode=text&piik-theme=system");
    page.cleanup();
  });

  it("keeps mode choices and the submit action available after a failed room start", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "link", sites: saved.sites, startupSite: "",
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onSelectSite() {}, onSubmit() {},
      roomError: createElement("p", { role: "alert" }, "Connection timed out"),
    }));
    expect(html).toContain("Connection timed out");
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/type="submit"[^>]*aria-label="(?:Retry|重试)"/);
    expect(html).toContain(saved.sites[0]);
    expect(html).toContain('aria-pressed="false"');
  });

  it("reopens a healthy room without offering another mode or password", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "local", sites: [], startupSite: "", target: "http://127.0.0.1:8787/#piik-client=1",
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onSubmit() {},
    }));
    expect(html).toContain('href="http://127.0.0.1:8787/#piik-client=1"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('type="password"');
  });

  it("renders complete App entries for saved sites and the existing room before any click", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "local", sites: saved.sites, startupSite: saved.sites[0]!,
      target: "http://127.0.0.1:8787/#piik-client=1",
      entryURL: target => clientLaunchURL(target, { lang: "en", vis: false, theme: "light", explicit: ["theme"] }, false, 39729),
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onSubmit() {},
    }));
    const entries = [...html.matchAll(/href="([^"]+)"/g)]
      .map(match => new URL(match[1]!.replaceAll("&amp;", "&")));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.searchParams.get("piik-client-port")).toBe("39729");
      expect(entry.searchParams.get("piik-preferences")).toBe("theme");
      const fragment = new URLSearchParams(entry.hash.slice(1));
      expect(fragment.get("piik-client")).toBe("1");
      expect(fragment.get("piik-lang")).toBe("en");
      expect(fragment.get("piik-theme")).toBe("light");
    }
    expect(entries.map(entry => entry.origin)).toEqual([saved.sites[0], "http://127.0.0.1:8787"]);
  });

  it("selects only an HTTP(S) origin for explicit approval, including pasted full URLs", () => {
    expect(siteEntryOrigin(" PIIK.example:443 ")).toBe("https://piik.example");
    expect(siteEntryOrigin("https://piik.example/r/1234?lang=en#v=private-invitation")).toBe("https://piik.example");
    expect(siteEntryOrigin("https://example.com/my room?q=hello world")).toBe("https://example.com");
    expect(siteEntryOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(siteEntryURL(" https://piik.example/r/1234?lang=en#v=private-invitation ")?.href)
      .toBe("https://piik.example/r/1234?lang=en#v=private-invitation");
    expect(siteEntryURL(" PIIK.example:443 ")?.href).toBe("https://piik.example/");
    for (const invalid of ["", "https://user:password@piik.example", "javascript:alert(1)", "file:///local", "https://", "not a site"]) {
      expect(siteEntryOrigin(invalid)).toBeNull();
      expect(siteEntryURL(invalid)).toBeNull();
    }
  });

  it.each([true, false])("opens a manually entered Site only after explicit approval succeeds (manual: %s)", async manual => {
    const fetch = vi.fn(async () => response());
    const page = mount(fetch, manual);
    await settle();
    fetch.mockResolvedValueOnce({ ...response(), ok: false, status: 503 });
    await page.approveSite("https://next.example");
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.state.SiteError).toBe("client.connect.saveFailed");
    fetch.mockResolvedValueOnce(response({ ...saved, sites: [...saved.sites, "https://next.example"] }));
    await page.approveSite("https://next.example");
    if (manual) expect(page.navigate).toHaveBeenCalledWith("https://next.example/#piik-client=1&piik-lang=en&piik-mode=text&piik-theme=system");
    else expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch.mock.calls[1]).toEqual(["/api/client-launcher/site", expect.objectContaining({
      body: JSON.stringify({ site: "https://next.example", allowed: true }),
    })]);
    page.cleanup();
  });

  it.each([true, false])("keeps approval pending until the optional startup preference settles (saved: %s)", async (savedStartup) => {
    const nextSite = "https://next.example";
    let finishStartup!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn(async () => response());
    const page = mount(fetch);
    await settle();
    fetch.mockResolvedValueOnce(response({ ...saved, sites: [...saved.sites, nextSite] }))
      .mockImplementationOnce(() => new Promise(resolve => { finishStartup = resolve; }));
    const approval = page.changeSite(nextSite, "site", true);
    await settle();
    expect(page.state).toMatchObject({ Sites: [...saved.sites, nextSite], StartupSite: "", SiteBusy: true });
    expect(fetch.mock.calls[2]).toEqual(["/api/client-launcher/startup-site", expect.objectContaining({
      body: JSON.stringify({ site: nextSite }),
    })]);
    finishStartup({ ...response({ ...saved, sites: [...saved.sites, nextSite], startupSite: savedStartup ? nextSite : "" }),
      ok: savedStartup, status: savedStartup ? 200 : 503 });
    await approval;
    expect(page.state).toMatchObject({ Sites: [...saved.sites, nextSite], SiteBusy: false,
      StartupSite: savedStartup ? nextSite : "", SiteError: savedStartup ? undefined : "client.connect.saveFailed" });
    page.cleanup();
  });

  it("restores saved choices after a failed first read, then preserves unsaved edits on focus", async () => {
    const fetch = vi.fn(async () => response()).mockRejectedValueOnce(new Error("unavailable"));
    const page = mount(fetch);
    await settle();
    expect(page.state.Error).toEqual({ kind: "load" });
    page.focus();
    await settle();
    expect(page.state).toMatchObject({
      Error: null, Loading: false, Sites: saved.sites, Lan: saved.lan,
    });
    Object.assign(page.state, { Mode: "local", LanAddress: "192.0.2.2" });
    page.focus();
    await settle();
    expect(page.state).toMatchObject({ Mode: "local", Lan: { selected: "192.0.2.2" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(page.state.Build).toMatchObject({ version: saved.version, revision: saved.revision });
    page.cleanup();
  });

  it("preserves launch errors on successful reads and accepts the App's current failure detail", async () => {
    const fetch = vi.fn(async () => response());
    const page = mount(fetch);
    await settle();
    page.state.Error = { kind: "launch", detail: "launch request failed" };
    page.focus();
    await settle();
    expect(page.state.Error).toEqual({ kind: "launch", detail: "launch request failed" });
    fetch.mockResolvedValueOnce(response({ ...saved, detail: "App runtime failed" }));
    page.focus();
    await settle();
    expect(page.state.Error).toEqual({ kind: "launch", detail: "App runtime failed" });
    page.cleanup();
  });

  it("ignores an in-flight response and future focus after retirement", async () => {
    let complete!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; }));
    const page = mount(fetch);
    page.cleanup();
    complete(response());
    await settle();
    page.focus();
    expect(fetch).toHaveBeenCalledOnce();
    expect(page.state).toEqual({ Mode: "link" });
    for (const setter of Object.values(page.setters)) expect(setter).not.toHaveBeenCalled();
  });

  it.each(["site", "startup-site", "debug", "launch"] as const)("rejects stale read success and failure around a %s command", async (operation) => {
    for (const failedRead of [false, true]) {
      let resolveRead!: (value: ReturnType<typeof response>) => void;
      let rejectRead!: (error: Error) => void;
      const fetch = vi.fn(async (_url: string, options?: { method?: string }) => options?.method === "POST"
        ? { ok: true, status: 200, json: async () => ({ sites: [], startupSite: "", target: "https://room.example" }) }
        : response());
      const page = mount(fetch);
      await settle();
      fetch.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
      page.focus();
      if (operation === "site") await page.changeSite(saved.sites[0]!, "site", false, false);
      if (operation === "startup-site") await page.changeSite(saved.sites[0]!, "startup-site");
      if (operation === "debug") await page.enableDebug();
      if (operation === "launch") await page.launch({ preventDefault() {} });
      const committed = { ...page.state };
      if (failedRead) rejectRead(new Error("old read failed"));
      else resolveRead(response());
      await settle();
      expect(page.state).toEqual(committed);
      // One existing poll recovers the current App fact without restoring user edits.
      page.state.LanAddress = "192.0.2.2";
      fetch.mockResolvedValueOnce(response({ ...saved, sites: [], debug: true }));
      page.retry();
      await settle();
      expect(page.state).toMatchObject({ Sites: [], AppDebug: true, Lan: { selected: "192.0.2.2" } });
      page.cleanup();
    }
  });

  it("waits for all overlapping commands before reading again", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const fetch = vi.fn((_url: string, options?: { method?: string }) => options?.method === "POST"
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response()));
    const page = mount(fetch);
    await settle();
    const approve = page.changeSite(saved.sites[0]!, "site", false, false);
    const debug = page.enableDebug();
    page.focus();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[0]!({ ok: true, status: 200, json: async () => ({ sites: [], startupSite: "" }) });
    await approve;
    page.retry();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[1]!({ ok: true });
    await debug;
    page.retry();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(4);
    page.cleanup();
  });
});

it("releases the approval page when saving a site never responds", async () => {
    const fetch = vi.fn(async (_url: string, options?: { method?: string; signal?: AbortSignal }) => {
      if (options?.method === "POST") return await new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
      return response();
    });
    const page = mount(fetch, true);
    await settle();
    const approval = page.approveSite("https://next.example");
    await settle();
    expect(page.state.SiteBusy).toBe(true);
    page.expireRequest();
    await approval;
    expect(page.state).toMatchObject({ SiteBusy: false, SiteError: "client.connect.saveFailed" });
    expect(page.navigate).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(response({ ...saved, sites: [...saved.sites, "https://next.example"] }));
    await page.approveSite("https://next.example");
    expect(page.navigate).toHaveBeenCalledWith("https://next.example/#piik-client=1&piik-lang=en&piik-mode=text&piik-theme=system");
    expect(page.state.SiteBusy).toBe(false);
    page.cleanup();
  });

it("keeps committed approval when the startup preference body stalls", async () => {
    const nextSite = "https://next.example";
    const approved = { ...saved, sites: [...saved.sites, nextSite] };
    const fetch = vi.fn(async (url: string, options?: { method?: string; signal?: AbortSignal }) => {
      if (url.endsWith("/startup-site")) return { ...response(), json: () => new Promise<never>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }) };
      return response(options?.method === "POST" ? approved : saved);
    });
    const page = mount(fetch, true);
    await settle();
    const approval = page.changeSite(nextSite, "site", true);
    await settle();
    expect(page.state).toMatchObject({ Sites: approved.sites, StartupSite: "", SiteBusy: true });
    page.expireRequest();
    await expect(approval).resolves.toBe(false);
    expect(page.state).toMatchObject({ Sites: approved.sites, StartupSite: "", SiteBusy: false, SiteError: "client.connect.saveFailed" });
    page.cleanup();
  });

it("enters the fresh App-owned startup result once with its current debug setting and port", async () => {
  vi.stubGlobal("window", { location: { href: "http://127.0.0.1:39731/client?start=1" } });
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...saved, starting: true } as typeof saved));
  const page = mount(fetch, false, { startup: true });
  try {
    await settle();
    expect(page.navigate).not.toHaveBeenCalled();
    const fresh = "http://127.0.0.1:45678/#piik-client=1";
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...saved, target: fresh, debug: true, controlPort: 39732 }) });
    page.retry();
    await settle();
    const destination = new URL(page.navigate.mock.calls[0]![0]);
    expect(destination.origin).toBe("http://127.0.0.1:45678");
    expect(destination.searchParams.get("debug")).toBe("1");
    expect(destination.searchParams.get("piik-client-port")).toBe("39732");
    page.focus();
    await settle();
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true);
  } finally {
    page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("leaves a failed owned startup available for manual retry", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...saved, detail: "tunnel failed" }));
  const page = mount(fetch, false, { startup: true });
  try {
    await settle();
    expect(page.state.Starting).toBe(false);
    expect(page.state.Error).toMatchObject({ kind: "launch" });
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ target: "http://127.0.0.1:45678/" }) });
    await page.launch({ preventDefault() {} });
    expect(page.navigate).toHaveBeenCalledTimes(1);
  } finally { page.cleanup(); }
});

it("clears an owned startup from the existing settings operation", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({
    ok: true, status: 200, json: async () => ({ ...saved, startupMode: "link", ownedSites: ["https://current.example"] }),
  });
  const page = mount(fetch);
  try {
    await settle();
    expect(page.state.StartupMode).toBe("link");
    fetch.mockResolvedValueOnce(response(saved));
    expect(await page.changeSite("", "startup-site")).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ site: "" });
    expect(page.state.StartupMode).toBeUndefined();
    expect(page.navigate).not.toHaveBeenCalled();
  } finally { page.cleanup(); }
});


it.each(["local", "link"] as const)("names the owned startup site and saved %s mode", mode => {
  const html = renderToStaticMarkup(createElement(LauncherForm, {
    mode, sites: saved.sites, startupSite: "", ownedStartup: mode,
    onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onSubmit() {},
  }));
  expect(html).toMatch(/my site|我的站点/);
  expect(html).toMatch(mode === "local" ? /Local network|局域网使用/ : /Public invite|公网邀请/);
  expect(html).toMatch(/type="checkbox"[^>]*checked/);
});
