import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the button's actual operation and unmount effect without a Browser.
// Discovery has separate transport tests; this covers who may activate a page.
const source = ts.createSourceFile("AppConnectionButton.tsx", readFileSync(
  new URL("../src/client/components/living/AppConnectionButton.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let connect: string | undefined;
let effect: string | undefined;
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "connect") connect = node.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    effect = node.arguments[0]!.getText(source);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!connect || !effect) throw new Error("Missing App connection operation or cleanup");
const executable = ts.transpileModule(`${connect}\n({ connect, cleanup: (${effect})() });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const site = "https://site.example";
const approval = `http://127.0.0.1:39721/client?site=${encodeURIComponent(site)}`;

function mount() {
  const popup = { closed: false, close: vi.fn(() => { popup.closed = true; }), location: { replace: vi.fn() } };
  const window = Object.assign(new EventTarget(), { open: vi.fn(() => popup), location: { origin: site } });
  const native = {
    discoverNativeConnect: vi.fn(async (_signal: AbortSignal) => approval),
    discoverNativeHealth: vi.fn(async (_options: { signal: AbortSignal }): Promise<object | null> => ({})),
    NativeCompatibilityError: class extends Error {},
  };
  const pending = { current: null as { controller: AbortController } | null };
  const setState = vi.fn();
  const activateClient = vi.fn();
  const onConnected = vi.fn();
  const operation = runInNewContext(executable, {
    window, pending, setState, activateClient, onConnected, AbortController, URL,
    require: (path: string) => {
      if (path !== "../../native/client") throw new Error(`Unexpected dependency: ${path}`);
      return native;
    },
  }) as { connect: () => Promise<void>; cleanup: () => void };
  function message(overrides: Record<string, unknown> = {}) {
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: popup, origin: new URL(approval).origin, data: { type: "piik-app-approved", site }, ...overrides,
    }));
  }
  return { ...operation, popup, window, native, pending, setState, activateClient, onConnected, message };
}

describe("App connection approval", () => {
  it("requires the exact window, origin and site, then verifies App health once", async () => {
    const page = mount();
    let complete!: (health: object) => void;
    page.native.discoverNativeHealth.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await page.connect();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledOnce();
    expect(page.popup.location.replace).toHaveBeenCalledWith(approval);
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
    expect(page.popup.closed).toBe(true);
    expect(page.pending.current).toBeNull();
    expect(page.native.discoverNativeConnect.mock.calls[0]![0].aborted).toBe(true);
    page.message();
    expect(page.native.discoverNativeHealth).toHaveBeenCalledOnce();
  });

  it.each(["absent", "failed"])("does not activate from an approval message when health is %s", async result => {
    const page = mount();
    if (result === "absent") page.native.discoverNativeHealth.mockResolvedValue(null);
    else page.native.discoverNativeHealth.mockRejectedValue(new Error("network unavailable"));
    await page.connect();
    page.message();
    await settle();
    expect(page.activateClient).not.toHaveBeenCalled();
    expect(page.onConnected).not.toHaveBeenCalled();
    expect(page.setState).toHaveBeenLastCalledWith("unavailable");
    expect(page.popup.closed).toBe(true);
    expect(page.pending.current).toBeNull();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledTimes(2);
    page.cleanup();
  });

  it("ignores a late healthy response after unmount and closes the popup", async () => {
    const page = mount();
    let complete!: (health: object) => void;
    page.native.discoverNativeHealth.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await page.connect();
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
    expect(page.setState).toHaveBeenLastCalledWith("busy");
  });

  it("never navigates the popup when discovery completes after unmount", async () => {
    const page = mount();
    let complete!: (url: string) => void;
    page.native.discoverNativeConnect.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = page.connect();
    await settle();
    page.cleanup();
    complete(approval);
    await connecting;
    expect(page.popup.location.replace).not.toHaveBeenCalled();
    expect(page.popup.closed).toBe(true);
    expect(page.activateClient).not.toHaveBeenCalled();
  });

  it("releases a closed approval window on focus and permits retry", async () => {
    const page = mount();
    await page.connect();
    page.popup.closed = true;
    page.window.dispatchEvent(new Event("focus"));
    expect(page.pending.current).toBeNull();
    expect(page.setState).toHaveBeenLastCalledWith("idle");
    page.message();
    expect(page.native.discoverNativeHealth).not.toHaveBeenCalled();
    await page.connect();
    expect(page.window.open).toHaveBeenCalledTimes(2);
    page.cleanup();
  });
});
