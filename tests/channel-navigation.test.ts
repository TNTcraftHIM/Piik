import { afterEach, expect, test, vi } from "vitest";
import { rememberRoom, selectedRoom } from "../src/client/channel/navigation";
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

test.each([false, true])("hash navigation stays on the latest room after late admission (History throws: %s)", async historyThrows => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("location", new URL("https://channel.test/#room=original"));
  const browserHistory = { state: null as unknown, replaceState: vi.fn((state: unknown) => {
    if (historyThrows) throw new DOMException("History unavailable", "SecurityError");
    browserHistory.state = state;
  }) };
  vi.stubGlobal("history", browserHistory);
  let selected = "original";
  const onSelect = vi.fn((room: string) => { rememberRoom(room); selected = room; });
  let admitFirst!: (room: string) => void;
  const first = new Promise<string>(resolve => { admitFirst = resolve; });
  session.acceptInvitation.mockReturnValueOnce(first).mockResolvedValueOnce("second");
  useChannel(onSelect);

  location.hash = "room=first&invite=first-key";
  window.dispatchEvent(new Event("hashchange"));
  expect(selected).toBe("first");
  expect(session.acceptInvitation).toHaveBeenCalledTimes(1);
  location.hash = "room=second";
  window.dispatchEvent(new Event("hashchange"));
  expect(selected).toBe("second");
  admitFirst("first");
  await first;
  expect(selected).toBe("second");
  expect(onSelect.mock.calls).toEqual([["first"], ["second"]]);
  expect(selectedRoom()).toBe("second");
});
