import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { NativeCompatibilityError } from "../src/client/native/client";

// Exercise the page's connection owner without mounting media or room signaling.
const source = ts.createSourceFile("ViewerPage.tsx", readFileSync(
  new URL("../src/client/pages/ViewerPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["nativeClientPromise", "nativeViewerAvailable", "acquireNativeClient"]);
const declarations: string[] = [];
let cleanup = "";
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && owners.has(node.name.getText(source))) {
    declarations.push(`let ${node.getText(source)};`);
  }
  if (ts.isExpressionStatement(node) && node.getText(source).startsWith("void nativeClientPromise?.then")) {
    cleanup = node.getText(source);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (declarations.length !== owners.size || !cleanup) throw new Error("Viewer Native owner was not found");
const executable = ts.transpile(`
  let active = true;
  ${declarations.join("\n")}
  globalThis.acquire = acquireNativeClient;
  globalThis.disable = () => { nativeViewerAvailable = false; };
  globalThis.dispose = () => { active = false; ${cleanup} };
`, { target: ts.ScriptTarget.ES2022 });

function control() {
  let onClose: () => void = () => undefined;
  return {
    close: vi.fn(),
    onClose: (listener: () => void) => { onClose = listener; },
    disconnect: () => onClose(),
  };
}

function fixture(launchedByClient = true) {
  const connect = vi.fn(async (): Promise<ReturnType<typeof control> | null> => null);
  const context = createContext({ launchedByClient, NativeClient: { connect } });
  runInContext(executable, context);
  return {
    connect,
    acquire: context.acquire as () => Promise<ReturnType<typeof control> | null>,
    disable: context.disable as () => void,
    dispose: context.dispose as () => void,
  };
}

it.each([false, true])("retries an absent or rejected App on the next offer: reject=%s", async (reject) => {
  const current = fixture();
  if (reject) current.connect.mockRejectedValueOnce(new Error("App unavailable"));
  await expect(current.acquire()).resolves.toBeNull();
  expect(current.connect).toHaveBeenCalledOnce();
  const client = control();
  current.connect.mockResolvedValue(client);
  await expect(current.acquire()).resolves.toBe(client);
  await expect(current.acquire()).resolves.toBe(client);
  expect(current.connect).toHaveBeenCalledTimes(2);
  current.dispose();
  await Promise.resolve();
  expect(client.close).toHaveBeenCalledOnce();
});

it("keeps Browser fallback available after an App mismatch and retries on the next offer", async () => {
  const current = fixture();
  current.connect.mockRejectedValueOnce(new NativeCompatibilityError(8));
  await expect(current.acquire()).resolves.toBeNull();
  const client = control();
  current.connect.mockResolvedValue(client);
  await expect(current.acquire()).resolves.toBe(client);
  expect(current.connect).toHaveBeenCalledTimes(2);
  current.dispose();
});

it("shares pending discovery and rediscovers after the idle App disconnects", async () => {
  const current = fixture();
  const client = control();
  let resolve!: (value: typeof client) => void;
  current.connect.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const first = current.acquire();
  const second = current.acquire();
  expect(current.connect).toHaveBeenCalledOnce();
  resolve(client);
  await expect(Promise.all([first, second])).resolves.toEqual([client, client]);
  client.disconnect();
  const replacement = control();
  current.connect.mockResolvedValue(replacement);
  await expect(current.acquire()).resolves.toBe(replacement);
  expect(current.connect).toHaveBeenCalledTimes(2);
  current.dispose();
});

it("closes discovery completed after unmount and refuses further acquisition", async () => {
  const current = fixture();
  const client = control();
  let resolve!: (value: typeof client) => void;
  current.connect.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const acquiring = current.acquire();
  current.dispose();
  resolve(client);
  await expect(acquiring).resolves.toBeNull();
  expect(client.close).toHaveBeenCalledOnce();
  await expect(current.acquire()).resolves.toBeNull();
  expect(current.connect).toHaveBeenCalledOnce();
});

it("does not hand an already closed discovery result to a media peer", async () => {
  const current = fixture();
  const closed = control();
  closed.onClose = (listener) => listener();
  current.connect.mockResolvedValueOnce(closed);
  await expect(current.acquire()).resolves.toBeNull();
  const replacement = control();
  current.connect.mockResolvedValue(replacement);
  await expect(current.acquire()).resolves.toBe(replacement);
  expect(current.connect).toHaveBeenCalledTimes(2);
  current.dispose();
});

it("keeps proven bridge failure disabled without closing another peer's shared control", async () => {
  const current = fixture();
  const client = control();
  current.connect.mockResolvedValue(client);
  await current.acquire();
  current.disable();
  await expect(current.acquire()).resolves.toBeNull();
  expect(current.connect).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();
  current.dispose();
  await Promise.resolve();
  expect(client.close).toHaveBeenCalledOnce();

  const browser = fixture(false);
  await expect(browser.acquire()).resolves.toBeNull();
  expect(browser.connect).not.toHaveBeenCalled();
});
