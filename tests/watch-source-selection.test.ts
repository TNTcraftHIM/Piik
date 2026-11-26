import { afterEach, expect, test, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { ChannelSession } from "../src/client/channel/session";
import { watchSourceSchema } from "../src/client/channel/protocol";
import { canWatchInBrowser, originalWatchURL, sharedWatchEmbed } from "../src/client/channel/watch-embed-source";

afterEach(() => vi.unstubAllGlobals());

test("website locators are optional values and do not manufacture an original-page capability", () => {
  const opaque = watchSourceSchema.parse({ kind: "website" });
  expect(opaque).toEqual({ kind: "website" });
  expect(originalWatchURL(opaque)).toBeUndefined();
  expect(sharedWatchEmbed(opaque)).toBeNull();
  expect(canWatchInBrowser(opaque)).toBe(false);
  const portable = watchSourceSchema.parse({ kind: "website", mediaUrl: "https://media.test/film.mp4" });
  expect(canWatchInBrowser(portable)).toBe(true);
  expect(originalWatchURL(portable)).toBeUndefined();
  for (const field of ["url", "mediaUrl"]) {
    expect(watchSourceSchema.safeParse({ kind: "website", [field]: null }).success).toBe(false);
    expect(watchSourceSchema.safeParse({ kind: "website", [field]: "javascript:invalid" }).success).toBe(false);
  }
  expect(watchSourceSchema.safeParse({ kind: "media" }).success).toBe(false);
});

test.each(["commit", "cancel"] as const)("source discovery survives preparation failure until %s", async finish => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("location", { origin: "https://source.test", hash: "" });
  vi.stubGlobal("history", { state: null });
  const session = new ChannelSession();
  const candidateId = crypto.randomUUID();
  const media = (name: string) => ({ id: crypto.randomUUID(), displayURL: "https://source.test/" + name + ".mp4", name, format: "file" });
  const [a, b, c] = ["A", "B", "C"].map(media);
  let choices = [a];
  let delayDiscovery = false;
  let finishDiscovery!: () => void;
  const late = new Promise<void>(resolve => { finishDiscovery = resolve; });
  const prepare = vi.fn(async (_id: unknown) => { throw new Error("watch_media_access_denied"); });
  const catalog = vi.fn(async () => {
    if (delayDiscovery) await late;
    return { choices, indexedCandidates: [], mpdCandidates: [], byteSource: null };
  });
  const dispose = vi.fn();
  const request = vi.fn(async (_command: unknown, reply: (event: unknown) => void) => {
    reply({ type: "room_reply", result: { type: "watch_ready", serverTime: performance.now() } });
  });
  const page = new AppPage(crypto.randomUUID(), "https://source.test/watch", async command => {
    if (command.type === "page_media_sources") return catalog();
    if (command.type === "page_media_prepare") return prepare(command.choiceId);
    if (command.type === "page_select" || command.type === "page_read")
      return { position: 0, rate: 1, readyState: 4, paused: false, duration: 20, ended: false, buffered: [] };
    throw Error("unexpected " + command.type);
  }, dispose, () => {});
  Object.assign(session, { connectApp: async () => ({ preparePage: async () => page }), request });
  const changed = () => page.receive({ type: "page_media_changed", pageId: page.id });
  try {
    await session.prepareWatchPage("room", page.url);
    page.receive({ type: "page_candidates", pageId: page.id, url: page.url, candidates: [{ pageURL: page.url, id: candidateId, url: null, title: "Player", duration: 20 }] });
    expect(await session.selectWatchPage("room", candidateId)).toBe(false);
    const sources = session.watchPage("room")!.watchSources!;
    expect(sources.choices).toEqual([a]);
    choices = [b];
    changed();
    await vi.waitFor(() => expect(sources.choices).toEqual([b]));
    await expect(session.selectWatchForwardSource("room", b.id, false)).rejects.toThrow("watch_media_access_denied");
    choices = [c];
    changed();
    await vi.waitFor(() => expect(sources.choices).toEqual([c]));
    expect(prepare.mock.calls).toEqual([[b.id]]);
    expect(request).not.toHaveBeenCalled();

    delayDiscovery = true;
    choices = [a];
    changed();
    expect(catalog).toHaveBeenCalledTimes(4);
    if (finish === "commit") {
      await session.selectWatchBrowserSource("room", null);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "start_watch", source: { kind: "website", url: page.url } }), expect.any(Function), "room");
      expect(dispose).not.toHaveBeenCalled();
    } else {
      await session.cancelScreenSelection("room");
      expect(dispose).toHaveBeenCalledOnce();
    }
    expect(session.watchPage("room")).toBeUndefined();
    finishDiscovery();
    await new Promise(resolve => setTimeout(resolve, 0));
    changed();
    expect(catalog).toHaveBeenCalledTimes(4);
    expect(sources.choices).toEqual([c]);
  } finally {
    finishDiscovery();
    session.close();
  }
  expect(dispose).toHaveBeenCalledOnce();
});
