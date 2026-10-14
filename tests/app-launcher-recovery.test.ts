import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
  if (ts.isFunctionDeclaration(node) && ["beginStateChange", "changeSite", "enableDebug", "launch"].includes(node.name?.text ?? "")) {
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
const executable = ts.transpileModule(`${declarations.join("\n")}\n({cleanup: (${effect})(), changeSite, enableDebug, launch});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const saved = {
  site: "https://site.example", localAccessPassword: "saved password", defaultMode: "local",
  revision: "test", version: "development", debug: false,
  lan: { addresses: [{ address: "192.0.2.1", name: "LAN" }], selected: "192.0.2.1" },
};
const response = (state: typeof saved & { detail?: string } = saved) => ({ ok: true, json: async () => state });

function mount(fetch: ReturnType<typeof vi.fn>) {
  const state: Record<string, unknown> = {};
  const setters = Object.fromEntries([
    "Mode", "LocalAccessPassword", "Lan", "Version", "Target", "Starting", "Site",
    "AppDebug", "Debug", "Error", "Loading", "Update",
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
    siteBusy: false, debugBusy: false, starting: false, site: saved.site,
    mode: "link", lang: "en", vis: false, debug: false, appDebug: false, localAccessPassword: "",
    consoleLanguage: () => "en", launchURL: (target: string) => target, t: (key: string) => key,
    setTimeout: (callback: () => void, delay: number) => {
      expect(delay).toBe(750);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }) as { cleanup(): void; changeSite(site: string): Promise<void>; enableDebug(): Promise<void>; launch(event: { preventDefault(): void }): Promise<void> };
  return { state, setters, ...actions, checkReleaseUpdate, focus: () => window.dispatchEvent(new Event("focus")),
    retry: () => {
      expect(timers.size).toBe(1);
      const [id, callback] = [...timers][0]!;
      timers.delete(id);
      callback();
    },
  };
}

describe("App launcher state recovery", () => {
  it("restores saved choices after a failed first read, then preserves unsaved edits on focus", async () => {
    const fetch = vi.fn(async () => response()).mockRejectedValueOnce(new Error("unavailable"));
    const page = mount(fetch);
    await settle();
    expect(page.state.Error).toEqual({ kind: "load" });
    page.focus();
    await settle();
    expect(page.state).toMatchObject({
      Error: null, Loading: false, Site: saved.site, Mode: "local",
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

  it.each(["site", "debug", "launch"] as const)("rejects stale read success and failure around a %s command", async (operation) => {
    for (const failedRead of [false, true]) {
      let resolveRead!: (value: ReturnType<typeof response>) => void;
      let rejectRead!: (error: Error) => void;
      const fetch = vi.fn(async (_url: string, options?: { method?: string }) => options?.method === "POST"
        ? { ok: true, status: 200, json: async () => ({ site: "", target: "https://room.example" }) }
        : response());
      const page = mount(fetch);
      await settle();
      fetch.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
      page.focus();
      if (operation === "site") await page.changeSite("");
      if (operation === "debug") await page.enableDebug();
      if (operation === "launch") await page.launch({ preventDefault() {} });
      const committed = { ...page.state };
      if (failedRead) rejectRead(new Error("old read failed"));
      else resolveRead(response());
      await settle();
      expect(page.state).toEqual(committed);
      // One existing poll recovers the current App fact without restoring user edits.
      page.state.LocalAccessPassword = "unsaved";
      fetch.mockResolvedValueOnce(response({ ...saved, site: "", debug: true }));
      page.retry();
      await settle();
      expect(page.state).toMatchObject({ Site: "", Debug: true, LocalAccessPassword: "unsaved" });
      page.cleanup();
    }
  });

  it("waits for all overlapping commands before reading again", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const fetch = vi.fn((_url: string, options?: { method?: string }) => options?.method === "POST"
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response()));
    const page = mount(fetch);
    await settle();
    const approve = page.changeSite("");
    const debug = page.enableDebug();
    page.focus();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[0]!({ ok: true, status: 200, json: async () => ({ site: "" }) });
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
