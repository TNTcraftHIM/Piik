import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useKeyedSettingsAction } from "../src/client/channel/components/ChannelSettingsDialog";

test("picture feedback follows live publications across room views and reconnects", async () => {
  const view = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
  const ownerDocument = Object.assign(new EventTarget(), { nodeType: 9, defaultView: view });
  vi.stubGlobal("window", Object.assign(view, { document: ownerDocument }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument });
  const root = createRoot(container as unknown as HTMLElement);
  let action!: ReturnType<typeof useKeyedSettingsAction>;
  function Page(props: { owner: string; rows: { id: string }[]; room: string }) {
    action = useKeyedSettingsAction(props.owner, props.rows);
    return null;
  }
  const render = (ids: string[], room = "a", owner = "connected") => act(() => {
    root.render(createElement(Page, { owner, room, rows: ids.map(id => ({ id })) }));
  });
  const fail = async () => { throw new Error("picture_failed"); };
  try {
    const ids = Array.from({ length: 16 }, (_, index) => String(index));
    await render(ids);
    await act(async () => { await Promise.all(ids.map(id => action.run(id, fail))); });
    await render(ids, "b");
    expect(action.errors.size).toBe(16);
    await render([]);
    expect(action.errors.size).toBe(0);
    await render(["live"]);
    let reject!: (error: Error) => void;
    let report!: () => boolean;
    let pending!: Promise<void>;
    await act(() => {
      pending = action.run("live", fallback => {
        report = fallback;
        return new Promise((_, rejectWork) => { reject = rejectWork; });
      });
    });
    expect(report()).toBe(false);
    await render([]);
    expect(report()).toBe(true);
    await act(async () => { reject(new Error("late")); await pending; });
    expect(action.errors.size).toBe(0);
    await render(["live"]);
    await act(() => action.run("live", fail));
    await render(["live"], "b", "reconnected");
    expect(action.errors.size).toBe(0);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
