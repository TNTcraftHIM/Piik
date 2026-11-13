import { afterEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { OpenInClient } from "../src/client/components/living/OpenInClient";
import { clientNavigationTarget, useClientNavigationTarget } from "../src/client/channel/client-navigation";
import { APP_PROTOCOL, channelAppDiscovery } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { NATIVE_CLIENT_PORT_START } from "../src/client/native/discovery-ports";
import type { AppDiscovery } from "../src/client/native/discovery";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, cleanups: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
  useRef: (value: unknown) => {
    const index = hooks.index++;
    return hooks.values[index] ??= { current: value };
  },
  useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); },
}));
vi.mock("../src/client/ui/copy", () => ({ useCopy: () => ({ t: (key: string) => key, vis: false }) }));

afterEach(() => {
  hooks.cleanups.splice(0).forEach(cleanup => cleanup());
  hooks.values = []; hooks.index = 0;
  vi.unstubAllGlobals();
});
const site = "https://site.example/";
const invitation = `${site}#room=private&invite=original-secret`;
const local = `http://127.0.0.1:${NATIVE_CLIENT_PORT_START}/client`;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function buttons(node: unknown): ReactElement<{ onClick: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: unknown; onClick: () => void }>;
  return [...(element.type === "button" ? [element] : []), ...buttons(element.props.children)];
}
function mount(navigation: NonNullable<AppDiscovery["navigation"]> = vi.fn(async (_signal?: AbortSignal) => ({ url: local, windowNavigation: true }))) {
  const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  const open = vi.fn(() => popup);
  vi.stubGlobal("window", { open });
  const discovery = { navigation, health: vi.fn(), connect: vi.fn(), isIncompatible: () => false };
  const render = () => { hooks.index = 0; return OpenInClient({ discovery, targetURL: invitation, active: true, disabled: false, downloadURL: "https://download.example/" }); };
  buttons(render())[0]!.props.onClick();
  return { popup, open, discovery, render };
}

test("one click hands the original invitation to local confirmation without approving or connecting", async () => {
  const page = mount();
  expect(page.open).toHaveBeenCalledOnce();
  expect(page.discovery.navigation).toHaveBeenCalledOnce();
  await settle();
  const destination = new URL(page.popup.location.replace.mock.calls[0]![0]);
  expect(destination.pathname).toBe("/client");
  expect(destination.search).toBe("");
  expect(new URLSearchParams(destination.hash.slice(1)).get("open")).toBe(invitation);
  expect(page.popup.opener).toBeNull();
  expect(page.discovery.health).not.toHaveBeenCalled();
  expect(page.discovery.connect).not.toHaveBeenCalled();
  hooks.cleanups.splice(0).forEach(cleanup => cleanup());
  expect(page.popup.close).not.toHaveBeenCalled();
  // Subsequent opens have a real href, with the same visible action.
  const rendered = JSON.stringify(page.render());
  expect(rendered).toContain('"type":"a"');
  expect(rendered).toContain('"target":"_blank"');
});

test("missing native window closes the reserved tab and explains browser availability", async () => {
  const page = mount(vi.fn(async () => ({ url: local, windowNavigation: false })));
  await settle();
  expect(page.popup.close).toHaveBeenCalledOnce();
  expect(page.popup.location.replace).not.toHaveBeenCalled();
  expect(JSON.stringify(page.render())).toContain("client.connect.navigationUnsupported");
});

test("an absent App closes the reserved tab and offers the existing download link", async () => {
  const page = mount(vi.fn(async () => null));
  await settle();
  expect(page.popup.close).toHaveBeenCalledOnce();
  expect(page.popup.location.replace).not.toHaveBeenCalled();
  expect(JSON.stringify(page.render())).toContain("client.connect.download");
});

test("dismissal cancels discovery, closes its tab and rejects a late result", async () => {
  let resolve!: (value: { url: string; windowNavigation: boolean }) => void;
  const discovery = vi.fn((_signal?: AbortSignal) => new Promise<{ url: string; windowNavigation: boolean }>(done => { resolve = done; }));
  const page = mount(discovery);
  hooks.cleanups.splice(0).forEach(cleanup => cleanup());
  expect(discovery.mock.calls[0]![0]!.aborted).toBe(true);
  expect(page.popup.close).toHaveBeenCalledOnce();
  resolve({ url: local, windowNavigation: true }); await settle();
  expect(page.popup.location.replace).not.toHaveBeenCalled();
});

test("page memory survives admission cleanup, and another room receives no private invitation", () => {
  vi.stubGlobal("location", new URL(invitation));
  vi.stubGlobal("window", new EventTarget());
  expect(useClientNavigationTarget("private")).toBe(invitation);
  location.hash = "room=private"; // replaceState admission cleanup emits no hashchange.
  hooks.index = 0;
  expect(useClientNavigationTarget("private")).toBe(invitation);
  expect(clientNavigationTarget(invitation, "another")).toBe(`${site}#room=another`);
  expect(clientNavigationTarget(`${invitation}&owner=owner-secret&credential=session-secret`, "private")).toBe(invitation);
  location.hash = "room=second&invite=new-key";
  window.dispatchEvent(new Event("hashchange")); hooks.index = 0;
  expect(useClientNavigationTarget("second")).toBe(`${site}#room=second&invite=new-key`);
});

test.each([true, false])("navigation discovers verified capability without health or site approval (window: %s)", async windowNavigation => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL(site) });
  const fetcher = vi.fn(async (raw: string) => {
    if (raw !== `${local.replace("/client", "")}/connect-discovery`) return new Response(null, { status: 404 });
    return Response.json({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
      port: NATIVE_CLIENT_PORT_START, connectURL: local, windowNavigation });
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(channelAppDiscovery.navigation!()).resolves.toEqual({ url: local, windowNavigation });
  expect(fetcher.mock.calls.every(([url]) => url.endsWith("/connect-discovery"))).toBe(true);
});
