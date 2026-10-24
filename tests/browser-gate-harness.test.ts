import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchChrome } from "../scripts/browser-gate-harness";
import { parseVideoGateSize } from "../scripts/media-gate-geometry";

it("accepts bounded numeric gate sizes and rejects malformed or oversized sources", () => {
  expect(parseVideoGateSize("3840x2160")).toEqual({ width: 3840, height: 2160 });
  expect(parseVideoGateSize("2160x3840")).toEqual({ width: 2160, height: 3840 });
  expect(parseVideoGateSize("960x600")).toEqual({ width: 960, height: 600 });
  for (const value of ["", "1920", "1920x1080x2", "4.5x4", "0x1080", "1921x1080", "3840x3840", "8192x8192"]) {
    expect(() => parseVideoGateSize(value)).toThrow("30 fps capture limits");
  }
});

it.each(["Chrome", "shaper"])("cleans local pool startup after %s fails", async phase => {
  const { createServer } = await import("node:http");
  const servers: ReturnType<typeof createServer>[] = [];
  const cleanup = vi.fn(async (resources: { server: { close(): Promise<void> } }) => {
    await resources.server.close();
    return { browserExited: true, nativeExited: true, serverClosed: true, portsClosed: true, profileRemoved: true };
  });
  vi.doMock("node:http", () => ({ createServer: (...args: Parameters<typeof createServer>) => {
    const server = createServer(...args); servers.push(server); return server;
  } }));
  vi.doMock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn(), mkdtemp: async () => "fixture-profile" }));
  vi.doMock("esbuild", () => ({ build: async () => ({ outputFiles: [{ contents: Buffer.from("fixture") }] }) }));
  vi.doMock("../scripts/browser-pool-shaper.mjs", () => ({ createPoolShaper: async () => { throw new Error("shaper startup failed"); } }));
  vi.doMock("../scripts/browser-gate-harness", async () => ({
    ...await vi.importActual<typeof import("../scripts/browser-gate-harness")>("../scripts/browser-gate-harness"),
    cleanupRun: cleanup,
    launchChrome: async () => { throw Object.assign(new Error("missing Chrome"), { code: "ENOENT" }); },
  }));
  const argv = process.argv, exitCode = process.exitCode;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.argv = [process.execPath, "browser-local-pool-probe.ts", "carrier", ...(phase === "shaper" ? ["--network"] : [])];
    vi.resetModules();
    await import("../scripts/browser-local-pool-probe");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(servers.every(server => !server.listening)).toBe(true);
    expect(process.exitCode).toBe(1);
  } finally {
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    process.argv = argv; process.exitCode = exitCode; output.mockRestore();
    for (const module of ["node:http", "node:fs/promises", "esbuild", "../scripts/browser-gate-harness", "../scripts/browser-pool-shaper.mjs"]) vi.doUnmock(module);
    vi.resetModules();
  }
});

it("reports a missing browser executable through awaited startup", async () => {
  await expect(launchChrome(join(import.meta.dirname, "missing-browser.exe"), 9222,
    join(import.meta.dirname, "unused-profile"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("accepts repeated retirement of an absent Linux gate profile", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = vi.fn().mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
  const rm = vi.fn();
  vi.doMock("node:fs/promises", () => ({ lstat, rm }));
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    const { cleanupRun } = await import("../scripts/browser-gate-harness");
    const resources = { cdp: null, native: null, chrome: null, server: null,
      profile: join(tmpdir(), "piik-client-media-AbCd12"), ports: [] };
    expect((await cleanupRun(resources)).profileRemoved).toBe(true);
    expect((await cleanupRun(resources)).profileRemoved).toBe(true);
    expect(rm).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});
