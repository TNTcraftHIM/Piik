import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ChannelStageSource } from "../src/client/channel/components/ChannelStage";
import { useStagePicture } from "../src/client/channel/components/use-stage-picture";

afterEach(() => vi.unstubAllGlobals());

test.each(["handoff", "collapsed handoff", "user close", "revocation"])("retained screen PiP after a watch ends: %s", async outcome => {
  const view = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
  const ownerDocument = Object.assign(new EventTarget(), {
    nodeType: 9, defaultView: view, pictureInPictureElement: null as EventTarget | null,
    exitPictureInPicture: vi.fn(async () => {
      const previous = ownerDocument.pictureInPictureElement;
      ownerDocument.pictureInPictureElement = null;
      previous?.dispatchEvent(new Event("leavepictureinpicture"));
    }),
  });
  vi.stubGlobal("window", Object.assign(view, { document: ownerDocument }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (id: string) => id });
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument });
  const root = createRoot(container as unknown as HTMLElement);
  const makeVideo = (id: string) => Object.assign(new EventTarget(), {
    localName: "video", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument, readyState: 0,
    closest: () => ({ dataset: { publicationId: id } }),
    requestPictureInPicture: vi.fn(async () => {}),
  });
  const original = makeVideo("original"), replacement = makeVideo("replacement");
  const tile = { contains: (element: unknown) => element === replacement, querySelector: () => replacement };
  const stage = Object.assign(new EventTarget(), {
    querySelector: (selector: string) => selector.includes('"replacement"') ? tile : null,
  });
  const ref = { current: stage as unknown as HTMLElement };
  function Stage({ sources }: { sources: ChannelStageSource[] }) {
    useStagePicture(ref, sources);
    return null;
  }
  const render = (source: Partial<ChannelStageSource>) => act(() => {
    root.render(createElement(Stage, { sources: [source as ChannelStageSource] }));
  });
  const first = { kind: "watch", id: "original", roomId: "room", subscribed: true, pictureAdmitted: true } as const;
  const next = { kind: "screen", id: "replacement", roomId: "room", subscribed: true, pictureAdmitted: true } as const;
  try {
    await render(first);
    ownerDocument.pictureInPictureElement = original;
    const enter = new Event("enterpictureinpicture");
    Object.defineProperty(enter, "target", { value: original });
    stage.dispatchEvent(enter);

    await render({ kind: "waiting", id: first.id, roomId: first.roomId });
    expect(ownerDocument.exitPictureInPicture).not.toHaveBeenCalled();
    // Replacing a successor the viewer has not joined yet keeps the room naming the original.
    if (outcome === "collapsed handoff") await render({ kind: "watch", id: "pending", roomId: first.roomId, subscribed: false, pictureAdmitted: true, predecessor: { kind: first.kind, id: first.id } });
    await render({ ...next, subscribed: false, predecessor: { kind: first.kind, id: first.id } });
    await render(next);
    expect(replacement.requestPictureInPicture).not.toHaveBeenCalled();
    if (outcome === "user close") await ownerDocument.exitPictureInPicture();
    if (outcome === "revocation") {
      await render({ ...next, pictureAdmitted: false });
      expect(ownerDocument.exitPictureInPicture).toHaveBeenCalledOnce();
    }
    replacement.readyState = 2;
    stage.dispatchEvent(new Event("loadeddata"));
    expect(replacement.requestPictureInPicture).toHaveBeenCalledTimes(outcome.endsWith("handoff") ? 1 : 0);
  } finally {
    await act(() => root.unmount());
  }
});
