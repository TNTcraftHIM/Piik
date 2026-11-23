import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { APP_PROTOCOL } from "../src/client/channel/app-link";
import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "../src/client/native/discovery-ports";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function runtime(delay: number, capabilities: { pagePlayer?: boolean; externalScreenInputAvailable?: boolean } = {}) {
  for (let port = NATIVE_CLIENT_PORT_END; port >= NATIVE_CLIENT_PORT_START; port--) {
    const server = createServer((request, response) => {
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, service: "piik-channel-app",
          port, token: "fixture-token", ...(request.url === "/health" ? capabilities : {}),
          ...(request.url === "/connect-discovery" ? { connectURL: `http://127.0.0.1:${port}/client` } : {}),
        }));
      }, delay);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      servers.push(server);
      return { server, port };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Runtime affinity check needs two free native discovery ports");
}

it("selects the launched runtime over a faster resident App and never substitutes it after exit", async () => {
  const old = await runtime(0, { externalScreenInputAvailable: false });
  const selected = await runtime(30, { pagePlayer: false, externalScreenInputAvailable: true });
  const fetchHTTP = globalThis.fetch;
  const requestedPorts: number[] = [];
  // Keep the real HTTP fixtures independent of Apps already running locally.
  vi.stubGlobal("fetch", ((input, init) => {
    const port = Number(new URL(String(input)).port);
    requestedPorts.push(port);
    return port === old.port || port === selected.port
      ? fetchHTTP(input, init)
      : Promise.reject(new TypeError("Not this test's runtime"));
  }) as typeof fetch);
  const saved = new Map<string, string>();
  const tabSaved = new Map<string, string>();
  const page = {
    location: new URL("http://127.0.0.1:8787/"), setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); } },
    sessionStorage: { getItem: (key: string) => tabSaved.get(key) ?? null,
      setItem: (key: string, value: string) => { tabSaved.set(key, value); },
      removeItem: (key: string) => { tabSaved.delete(key); } },
    history: { state: null, replaceState: (_state: unknown, _unused: string, value: string) => {
      page.location = new URL(value, page.location);
    } },
  };
  vi.stubGlobal("window", page);
  const { discoverChannelAppHealth, channelAppDiscovery } = await import("../src/client/channel/app-link");
  const { consumeClientLaunchFragment, takeClientLaunchBootstrap, clientRuntimePort } = await import("../src/client/lib/app-launch");
  // Both actual HTTP stubs are discoverable; the older one responds first.
  await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: old.port });
  page.location.hash = `piik-client=1&piik-client-port=${selected.port}`;
  takeClientLaunchBootstrap();
  requestedPorts.length = 0;
  // Another local client can probe the same listening port during this assertion.
  await (await fetchHTTP(`http://127.0.0.1:${old.port}/connect-discovery`)).text();
  await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: selected.port, pagePlayer: false, externalScreenInputAvailable: true });
  await expect(channelAppDiscovery.connect()).resolves.toContain(`127.0.0.1:${selected.port}/client?`);
  expect(requestedPorts).not.toContain(old.port);
  expect(page.location.href).toBe("http://127.0.0.1:8787/");
  expect([...saved.keys()]).toEqual(["piik:client-launch:v1"]);
  expect([...tabSaved.values()]).toEqual([String(selected.port)]);
  takeClientLaunchBootstrap(); // Consuming an already-clean URL keeps this page's affinity.
  expect(clientRuntimePort()).toBe(selected.port);
  page.location.hash = `room=other&invite=fixture&piik-client=1&piik-client-port=${old.port}`;
  consumeClientLaunchFragment();
  expect(page.location.hash).toBe("#room=other&invite=fixture");
  expect(clientRuntimePort()).toBe(selected.port);
  await new Promise<void>(resolve => { selected.server.close(() => resolve()); selected.server.closeAllConnections(); });
  await expect(discoverChannelAppHealth()).resolves.toBeNull();
  await expect(channelAppDiscovery.connect()).resolves.toBeNull();
  expect(requestedPorts).not.toContain(old.port);
  vi.resetModules();
  const reloaded = await import("../src/client/lib/app-launch");
  reloaded.takeClientLaunchBootstrap();
  expect(reloaded.clientRuntimePort()).toBe(selected.port);
  expect(reloaded.isClientActivated()).toBe(true);
  const reloadedDiscovery = await import("../src/client/channel/app-link");
  await expect(reloadedDiscovery.discoverChannelAppHealth()).resolves.toBeNull();
  expect(requestedPorts).not.toContain(old.port);
  // A new explicit launch replaces this tab's previous selection.
  page.location.hash = `piik-client=1&piik-client-port=${old.port}`;
  reloaded.takeClientLaunchBootstrap();
  expect(reloaded.clientRuntimePort()).toBe(old.port);
  expect([...tabSaved.values()]).toEqual([String(old.port)]);
  // A fresh tab shares activation preference, but has its own session storage.
  vi.stubGlobal("window", { ...page, sessionStorage: { getItem: () => null } });
  vi.resetModules();
  const freshTab = await import("../src/client/lib/app-launch");
  expect(freshTab.clientRuntimePort()).toBeNull();
  const freshDiscovery = await import("../src/client/channel/app-link");
  await expect(freshDiscovery.discoverChannelAppHealth()).resolves.toMatchObject({ port: old.port });
});
