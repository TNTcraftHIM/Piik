import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LauncherForm } from "../src/client/components/living/LauncherForm";
import { siteEntryOrigin } from "../src/client/components/living/SiteAddressEntry";
import { clientLaunchURL } from "../src/client/lib/session";

// Run the page's actual state-read effect, including cleanup, without a DOM.
const source = ts.createSourceFile("AppLauncherPage.tsx", readFileSync(
  new URL("../src/client/pages/AppLauncherPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: string[] = [];
let effect: string | undefined;
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && /^launcher.*Schema$/.test(node.name.getText(source))) {
    declarations.push(`const ${node.getText(source)};`);
  }
  if (ts.isFunctionDeclaration(node) && ["beginStateChange", "changeSite", "approveSite", "enableDebug", "launch"].includes(node.name?.text ?? "")) {
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
const executable = ts.transpileModule(`${declarations.join("\n")}\n({cleanup: (${effect})(), changeSite, approveSite, enableDebug, launch});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const saved = {
  sites: ["https://site.example"], startupSite: "", localAccessPassword: "saved password", defaultMode: "local",
  revision: "test", version: "development", debug: false,
  lan: { addresses: [{ address: "192.0.2.1", name: "LAN" }], selected: "192.0.2.1" },
};
const response = (state: typeof saved & { detail?: string } = saved) => ({ ok: true, status: 200, json: async () => state });

function mount(fetch: ReturnType<typeof vi.fn>, manualSite = false) {
  const state: Record<string, unknown> = {};
  const setters = Object.fromEntries([
    "Mode", "Modes", "LocalAccessPassword", "Lan", "Version", "ControlPort", "Target", "Starting", "Sites", "StartupSite",
    "AppDebug", "Debug", "Error", "Loading", "Update", "RemoteControlPrototype",
    "SiteBusy", "SiteError", "DebugBusy", "DebugError", "Reload",
  ].map(name => [`set${name}`, vi.fn((value: unknown) => {
    state[name] = typeof value === "function" ? value(state[name]) : value;
  })]));
  const window = Object.assign(new EventTarget(), { location: { replace: vi.fn() } });
  const checkReleaseUpdate = vi.fn(async () => null);
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const actions = runInNewContext(executable, {
    ...setters, z, fetch, window, checkReleaseUpdate,
    stateChanges: { current: { revision: 0, pending: 0 } },
    siteBusy: false, debugBusy: false, starting: false, sites: saved.sites, manualSite, openOnApproval: false,
    mode: "link", lang: "en", vis: false, debug: false, appDebug: false, localAccessPassword: "",
    consoleLanguage: () => "en", launchURL: (target: string) => target, t: (key: string) => key,
    setTimeout: (callback: () => void, delay: number) => {
      expect(delay).toBe(750);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }) as { cleanup(): void; changeSite(site: string, setting?: "site" | "startup-site", starAfterApproval?: boolean, allowed?: boolean): Promise<boolean>; approveSite(site: string): Promise<void>; enableDebug(): Promise<void>; launch(event: { preventDefault(): void }): Promise<void> };
  return { state, setters, ...actions, checkReleaseUpdate, navigate: window.location.replace, focus: () => window.dispatchEvent(new Event("focus")),
    retry: () => {
      expect(timers.size).toBe(1);
      const [id, callback] = [...timers][0]!;
      timers.delete(id);
      callback();
    },
  };
}

describe("App launcher state recovery", () => {
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
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ target: "https://room.example/#piik-client=1" }) });
    await page.launch(event);
    expect(page.navigate).toHaveBeenCalledWith("https://room.example/#piik-client=1");
    page.cleanup();
  });

  it("keeps mode choices and the submit action available after a failed room start", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "link", sites: saved.sites, startupSite: "", localAccessPassword: "saved password",
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onSelectSite() {}, onLocalAccessPasswordChange() {}, onSubmit() {},
      roomError: createElement("p", { role: "alert" }, "Connection timed out"),
    }));
    expect(html).toContain("Connection timed out");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('value="saved password"');
    expect(html).toMatch(/type="submit"[^>]*aria-label="(?:Retry|重试)"/);
    expect(html).toContain(saved.sites[0]);
  });

  it("reopens a healthy room without offering another mode or password", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "local", sites: [], startupSite: "", localAccessPassword: "saved password", target: "http://127.0.0.1:8787/#piik-client=1",
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onLocalAccessPasswordChange() {}, onSubmit() {},
    }));
    expect(html).toContain('href="http://127.0.0.1:8787/#piik-client=1"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('type="password"');
  });

  it("renders complete App entries for saved sites and the existing room before any click", () => {
    const html = renderToStaticMarkup(createElement(LauncherForm, {
      mode: "local", sites: saved.sites, startupSite: saved.sites[0]!, localAccessPassword: "",
      target: "http://127.0.0.1:8787/#piik-client=1",
      entryURL: target => clientLaunchURL(target, { lang: "en", vis: false, theme: "light", explicit: ["theme"] }, false, 39729),
      onModeChange() {}, onToggleStartupSite() {}, onRemoveSite() {}, onLocalAccessPasswordChange() {}, onSubmit() {},
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
    for (const invalid of ["", "https://user:password@piik.example", "javascript:alert(1)", "file:///local", "https://", "not a site"]) {
      expect(siteEntryOrigin(invalid)).toBeNull();
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
    if (manual) expect(page.navigate).toHaveBeenCalledWith("https://next.example/#piik-client=1");
    else expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch.mock.calls[1]).toEqual(["/api/client-launcher/site", expect.objectContaining({
      body: JSON.stringify({ site: "https://next.example", allowed: true }),
    })]);
    page.cleanup();
  });

  it("uses the App's available modes and keeps existing desktop defaults", async () => {
    for (const modes of [undefined, ["local"]]) {
      const page = mount(vi.fn(async () => response({ ...saved, ...(modes ? { modes } : {}) })));
      await settle();
      expect(page.state.Modes).toEqual(modes ?? ["local", "link"]);
      expect(page.state.Mode).toBe("local");
      page.cleanup();
    }
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
      Error: null, Loading: false, Sites: saved.sites, Mode: "local",
      LocalAccessPassword: saved.localAccessPassword, Lan: saved.lan,
    });
    Object.assign(page.state, { Mode: "link", LocalAccessPassword: "edited", Lan: { selected: "192.0.2.2" } });
    page.focus();
    await settle();
    expect(page.state).toMatchObject({ Mode: "link", LocalAccessPassword: "edited", Lan: { selected: "192.0.2.2" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(page.checkReleaseUpdate).toHaveBeenCalledOnce();
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
    expect(page.state).toEqual({});
    expect(page.checkReleaseUpdate).not.toHaveBeenCalled();
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
      page.state.LocalAccessPassword = "unsaved";
      fetch.mockResolvedValueOnce(response({ ...saved, sites: [], debug: true }));
      page.retry();
      await settle();
      expect(page.state).toMatchObject({ Sites: [], Debug: true, LocalAccessPassword: "unsaved" });
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
