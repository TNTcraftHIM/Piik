import { afterEach, expect, test, vi } from "vitest";
import { useChannel } from "../src/client/channel/use-channel";

const { session, cleanups } = vi.hoisted(() => ({
  session: { start: vi.fn(), close: vi.fn(), acceptInvitation: vi.fn(), getSnapshot: () => ({}), subscribe: vi.fn(), refreshReadMarkers: vi.fn() },
  cleanups: [] as Array<() => void>,
}));

// Run the hook's real event handlers without introducing a DOM renderer dependency.
vi.mock("react", () => ({
  useState: () => [session],
  useSyncExternalStore: () => session.getSnapshot(),
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
}));

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

test("a persisted page return restarts the retired session and cleanup removes that listener", () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  const shown = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });
  useChannel();
  expect(session.start).toHaveBeenCalledOnce();
  window.dispatchEvent(shown(false));
  expect(session.start).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pagehide"));
  expect(session.close).toHaveBeenCalledOnce();
  window.dispatchEvent(shown(true));
  expect(session.start).toHaveBeenCalledTimes(2);
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.dispatchEvent(shown(true));
  expect(session.start).toHaveBeenCalledTimes(2);
});

test("hash invitation admission cannot replay an older room after navigation", async () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("location", new URL("https://channel.test/#room=original"));
  let admitFirst!: (room: string) => void;
  const first = new Promise<string>(resolve => { admitFirst = resolve; });
  session.acceptInvitation.mockReturnValueOnce(first).mockResolvedValueOnce("second");
  useChannel();
  location.hash = "room=first&invite=first-key";
  window.dispatchEvent(new Event("hashchange"));
  location.hash = "room=second";
  window.dispatchEvent(new Event("hashchange"));
  expect(session.acceptInvitation).toHaveBeenCalledTimes(2);
  admitFirst("first"); await first;
  expect(new URLSearchParams(location.hash.slice(1)).get("room")).toBe("second");
});
