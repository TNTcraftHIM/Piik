import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Run the page's actual state-read effect, including cleanup, without a DOM.
const source = ts.createSourceFile("AppLauncherPage.tsx", readFileSync(
  new URL("../src/client/pages/AppLauncherPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let schema: string | undefined;
let effect: string | undefined;
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "launcherStateSchema") {
    schema = `const ${node.getText(source)};`;
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[1]?.getText(source) === "[reload]") {
    effect = node.arguments[0]!.getText(source);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!schema || !effect) throw new Error("Missing App launcher state-read owner");
const executable = ts.transpileModule(`${schema}\n(${effect})();`, {
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
  ].map(name => [`set${name}`, vi.fn((value: unknown) => {
    state[name] = typeof value === "function" ? value(state[name]) : value;
  })]));
  const window = new EventTarget();
  const checkReleaseUpdate = vi.fn(async () => null);
  const cleanup = runInNewContext(executable, {
    ...setters, z, fetch, window, checkReleaseUpdate, setTimeout, clearTimeout,
  }) as () => void;
  return { state, setters, cleanup, checkReleaseUpdate, focus: () => window.dispatchEvent(new Event("focus")) };
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
});
