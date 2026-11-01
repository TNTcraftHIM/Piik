import { afterEach, describe, expect, it, vi } from "vitest";
import { setCopy } from "../src/client/ui/copy.ts";
import {
  clearHostRoom,
  clientLaunchURL,
  getStableClientId,
  isValidRoomId,
  parseAppRoute,
  mergeAuthenticatedHostRoom,
  readHostRoom,
  releaseHostRoom,
  readPreferredRoomId,
  readViewerGrant,
  readViewerRoute,
  watchViewerInvites,
  replaceViewerInvite,
  roomRouteForExplicitEntry,
  roomRouteFromInput,
  takeClientLaunchBootstrap,
  writeHostRoom,
  writePreferredRoom,
} from "../src/client/lib/session.ts";
import { deriveParticipantTopology } from "../src/client/lib/participant-topology.ts";
import { labelParticipantNames, labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";
import { qualityEvidenceWindowFromMetrics } from "../src/client/media/viewer-quality-evidence.ts";
import {
  collectConnectionMetrics,
  collectConnectionMetricsFromReport,
  collectNativeSenderQualityFromReport,
  createNativeSenderQualityAccumulator,
  createStatsAccumulator,
} from "../src/client/webrtc/stats.ts";

afterEach(() => {
  releaseHostRoom();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCopy({ lang: "zh", vis: false });
});

describe("browser-local display name", () => {
  it("disambiguates distinct chat senders while retaining repeated and historical names", () => {
    const first = { peerId: "viewer_AAAAAAsuffix", displayName: "观众" };
    const other = { peerId: "viewer_BBBBBBsuffix", displayName: "观众" };
    expect(labelParticipantNames([first, first]).map(sender => sender.label)).toEqual(["观众", "观众"]);
    const senders = labelParticipantNames([first, first, other, { ...first, displayName: "新昵称" }]);
    expect(senders[0].label).toBe(senders[1].label);
    expect(senders[0].label).not.toBe(senders[2].label);
    expect(senders[0].peerIdSuffix.length).toBeGreaterThan(6);
    expect(senders.map(sender => sender.displayName)).toEqual(["观众", "观众", "观众", "新昵称"]);
    expect(senders[3].label).toBe("新昵称");
  });

  it("extends only colliding room-scoped peer ID suffixes", () => {
    const { viewers: labeled } = labelParticipantSnapshot([
      {
        role: "viewer",
        peerId: "viewer_AAAAAAsuffix",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "host_12345678" },
      },
      {
        role: "viewer",
        peerId: "viewer_BBBBBBsuffix",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "viewer_AAAAAAsuffix" },
      },
      {
        role: "viewer",
        peerId: "viewer_independent",
        displayName: "朋友",
        upstream: { kind: "sfu" },
      },
    ]);

    expect(labeled[0].peerIdSuffix.length).toBeGreaterThan(6);
    expect(labeled[1].peerIdSuffix.length).toBeGreaterThan(6);
    expect(labeled[0].peerIdSuffix).not.toBe(labeled[1].peerIdSuffix);
    expect(labeled[2].peerIdSuffix).toHaveLength(6);
    expect(labeled[2].label).toBe("朋友");
    expect(labeled[0].label).toContain("同名 (");
  });

  it("keeps the shortest hidden suffix for distinct display names", () => {
    const { viewers: labeled } = labelParticipantSnapshot([
      {
        role: "viewer",
        peerId: "viewer_AAAAAAsuffix",
        displayName: "甲",
        upstream: { kind: "sfu" },
      },
      {
        role: "viewer",
        peerId: "viewer_BBBBBBsuffix",
        displayName: "乙",
        upstream: { kind: "sfu" },
      },
    ]);

    expect(labeled.map((viewer) => viewer.label)).toEqual(["甲", "乙"]);
    expect(labeled.map((viewer) => viewer.peerIdSuffix.length)).toEqual([6, 6]);
  });

  it("uses the minimum suffix when duplicate names are already distinct", () => {
    const { viewers: labeled } = labelParticipantSnapshot([
      {
        role: "viewer",
        peerId: "viewer_AAAAAA111111",
        displayName: "同名",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_BBBBBB222222",
        displayName: "同名",
        upstream: { kind: "none" },
      },
    ]);

    expect(labeled.map((viewer) => viewer.peerIdSuffix)).toEqual([
      "111111",
      "222222",
    ]);
    expect(labeled.map((viewer) => viewer.label)).toEqual([
      "同名 (111111)",
      "同名 (222222)",
    ]);
  });

  it("labels every Viewer in a participant snapshot without including the Host", () => {
    const { viewers: labeled } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_12345678",
        displayName: "分享者",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_111111",
        displayName: "朋友甲",
        upstream: { kind: "peer", peerId: "host_12345678" },
      },
      {
        role: "viewer",
        peerId: "viewer_222222",
        displayName: "朋友乙",
        upstream: { kind: "sfu" },
      },
    ]);

    expect(labeled.map((viewer) => viewer.label)).toEqual([
      "朋友甲",
      "朋友乙",
    ]);
  });

  it("labels Host and Viewer name collisions before splitting roles", () => {
    const labeled = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_123456",
        displayName: "同名",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_654321",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "host_123456" },
      },
      {
        role: "viewer",
        peerId: "viewer_789012",
        displayName: "唯一名称",
        upstream: { kind: "sfu" },
      },
    ]);

    expect(labeled.host?.label).toBe("同名 (123456)");
    expect(labeled.viewers.map((viewer) => viewer.label)).toEqual([
      "同名 (654321)",
      "唯一名称",
    ]);
  });

  it("derives exact peer and SFU branches without guessing orphaned routes", () => {
    const viewer = (
      peerId: string,
      upstream:
        | { kind: "none" }
        | { kind: "sfu" }
        | { kind: "peer"; peerId: string },
    ) => ({ role: "viewer" as const, peerId, displayName: peerId, upstream });
    const topology = deriveParticipantTopology(
      "host_12345678",
      labelParticipantSnapshot([
        viewer("viewer_root_1", { kind: "peer", peerId: "host_12345678" }),
        viewer("viewer_child_1", { kind: "peer", peerId: "viewer_root_1" }),
        viewer("viewer_sfu_1", { kind: "sfu" }),
        viewer("viewer_sfu_child", {
          kind: "peer",
          peerId: "viewer_sfu_1",
        }),
        viewer("viewer_pending", { kind: "none" }),
        viewer("viewer_orphan", { kind: "peer", peerId: "viewer_offline" }),
      ]).viewers,
    );

    expect(topology.peerRoots[0].viewer.peerId).toBe("viewer_root_1");
    expect(topology.peerRoots[0].children[0].viewer.peerId).toBe(
      "viewer_child_1",
    );
    expect(topology.sfuRoots[0].children[0].viewer.peerId).toBe(
      "viewer_sfu_child",
    );
    expect(topology.pending.map((entry) => entry.peerId)).toEqual([
      "viewer_orphan",
      "viewer_pending",
    ]);
  });
});

function hostRoomStorage(lockState: "available" | "held" | "absent" = "available") {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const held = new Set<string>();
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const request = vi.fn(async (name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => {
    if (lockState === "held" || held.has(name)) return callback(null);
    held.add(name);
    try { await callback({ name, mode: "exclusive" } as Lock); }
    finally { held.delete(name); }
  });
  vi.stubGlobal("window", {
    localStorage: storage(local), sessionStorage: storage(session),
    navigator: { locks: lockState === "absent" ? undefined : { request } },
  });
  return { local, session, held, request };
}

const storedHost = (roomId = "1234", hostToken = "a".repeat(32)) => ({
  roomId, hostToken, inviteUrl: `https://share.test/r/${roomId}`,
});

describe("client session identity", () => {
  it("works without secure-context-only crypto.randomUUID", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    const first = getStableClientId("viewer", "room-id-1234");

    expect(first).toBe("ab".repeat(16));
    expect(getStableClientId("viewer", "room-id-1234")).toBe(first);
  });

  it("persists a tab room and one validated origin resume hint without Viewer grants", async () => {
    const { local: values, session } = hostRoomStorage();
    const room = {
      roomId: "1234",
      hostToken: "a".repeat(32),
      inviteUrl: `https://share.test/r/1234#v=${"b".repeat(21)}A`,
      codeEntryPolicy: "open" as const,
    };

    await writeHostRoom(room);

    expect(await readHostRoom()).toEqual({
      roomId: "1234",
      hostToken: "a".repeat(32),
      canonicalUrl: "https://share.test/r/1234",
    });
    expect(values.get("piik:host-room:v1")).toBe(
      JSON.stringify({
        roomId: "1234",
        hostToken: "a".repeat(32),
        inviteUrl: "https://share.test/r/1234",
      }),
    );
    expect([...values.values()].join(" ")).not.toContain(`${"b".repeat(21)}A`);
    expect(session.get("piik:host-room:v1")).toBe(values.get("piik:host-room:v1"));
    clearHostRoom();
    expect(await readHostRoom()).toBeNull();
  });

  it("restores an origin resume hint only after claiming its room", async () => {
    const { local, session, request } = hostRoomStorage();
    local.set("piik:host-room:v1", JSON.stringify(storedHost("1234", "h".repeat(32))));
    expect(await readHostRoom()).toEqual({
      roomId: "1234",
      hostToken: "h".repeat(32),
      canonicalUrl: "https://share.test/r/1234",
    });
    expect(JSON.parse(session.get("piik:host-room:v1")!)).toEqual(JSON.parse(local.get("piik:host-room:v1")!));
    expect(request).toHaveBeenCalledWith(expect.stringMatching(/^piik:host-room:1234:[a-f0-9]{64}$/), { ifAvailable: true }, expect.any(Function));
    expect(request.mock.calls[0]![0]).not.toContain("h".repeat(32));
  });

  it("keeps stored room authority despite unowned metadata and discards malformed records", async () => {
    const { local: values, session } = hostRoomStorage();
    values.set("piik:host-room:v1", JSON.stringify({ ...storedHost(), unusedMetadata: 123 }));
    expect(await readHostRoom()).toEqual({
      roomId: "1234", hostToken: "a".repeat(32), canonicalUrl: "https://share.test/r/1234",
    });
    expect(JSON.parse(session.get("piik:host-room:v1")!)).toEqual(storedHost());
    releaseHostRoom();
    session.delete("piik:host-room:v1");
    values.set("piik:host-room:v1", "not-json");
    expect(await readHostRoom()).toBeNull();
    expect(values.has("piik:host-room:v1")).toBe(false);
  });

  it("rejects a copied tab room while another tab holds it without deleting that hint", async () => {
    const { local, session } = hostRoomStorage("held");
    const saved = JSON.stringify(storedHost());
    local.set("piik:host-room:v1", saved);
    session.set("piik:host-room:v1", saved);
    expect(await readHostRoom()).toBeNull();
    expect(session.has("piik:host-room:v1")).toBe(false);
    expect(local.get("piik:host-room:v1")).toBe(saved);
  });

  it("prefers this tab's room over another tab's latest hint and preserves that hint when forgotten", async () => {
    const { local, session } = hostRoomStorage();
    session.set("piik:host-room:v1", JSON.stringify(storedHost()));
    const other = JSON.stringify(storedHost("5678", "b".repeat(32)));
    local.set("piik:host-room:v1", other);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
    clearHostRoom();
    expect(session.has("piik:host-room:v1")).toBe(false);
    expect(local.get("piik:host-room:v1")).toBe(other);
  });

  it("retains both records on unmount, reclaims on refresh, and releases the old claim on rotation", async () => {
    const { local, session, held, request } = hostRoomStorage();
    const room = storedHost();
    await writeHostRoom({ ...room, codeEntryPolicy: "open" });
    const stored = local.get("piik:host-room:v1");
    releaseHostRoom();
    expect(session.get("piik:host-room:v1")).toBe(stored);
    expect(local.get("piik:host-room:v1")).toBe(stored);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
    expect(request).toHaveBeenCalledTimes(2);
    await writeHostRoom({ ...storedHost("5678", "b".repeat(32)), codeEntryPolicy: "open" });
    expect(held.size).toBe(1);
    expect([...held][0]).toContain(":5678:");
  });

  it("coalesces concurrent restoration and preserves records when an unmounted restore is cancelled", async () => {
    const { local, session, request } = hostRoomStorage();
    local.set("piik:host-room:v1", JSON.stringify(storedHost()));
    const first = await Promise.all([readHostRoom(), readHostRoom()]);
    expect(first[0]).toEqual(first[1]);
    expect(request).toHaveBeenCalledOnce();
    releaseHostRoom();
    const cancelled = readHostRoom();
    releaseHostRoom();
    expect(await cancelled).toBeNull();
    expect(session.has("piik:host-room:v1")).toBe(true);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
  });

  it("does not reuse the origin hint without Web Locks but keeps same-tab refresh authority", async () => {
    const { local, session } = hostRoomStorage("absent");
    const saved = JSON.stringify(storedHost());
    local.set("piik:host-room:v1", saved);
    expect(await readHostRoom()).toBeNull();
    session.set("piik:host-room:v1", saved);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
    releaseHostRoom();
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
  });

  it("does not erase the resume hint when the server replaces this Host session", async () => {
    const { local, session } = hostRoomStorage();
    await writeHostRoom({ ...storedHost(), codeEntryPolicy: "open" });
    const saved = local.get("piik:host-room:v1");
    clearHostRoom(true);
    expect(session.has("piik:host-room:v1")).toBe(false);
    expect(local.get("piik:host-room:v1")).toBe(saved);
  });

  it("keeps same-tab authority when Web Locks are denied, without restoring the origin hint", async () => {
    const { local, session, request } = hostRoomStorage();
    request.mockRejectedValue(new DOMException("Blocked", "SecurityError"));
    const saved = JSON.stringify(storedHost());
    local.set("piik:host-room:v1", saved);
    expect(await readHostRoom()).toBeNull();
    session.set("piik:host-room:v1", saved);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234" });
    expect(session.get("piik:host-room:v1")).toBeTruthy();
  });

  it("does not persist an obsolete creation and gives a reused code a distinct incarnation claim", async () => {
    const { local, held, request } = hostRoomStorage();
    let owns = true;
    const cancelled = writeHostRoom({ ...storedHost(), codeEntryPolicy: "open" }, () => owns);
    owns = false;
    expect(await cancelled).toBe(false);
    expect(local.size).toBe(0);
    await writeHostRoom({ ...storedHost(), codeEntryPolicy: "open" });
    const first = request.mock.calls.at(-1)![0];
    await writeHostRoom({ ...storedHost("1234", "b".repeat(32)), codeEntryPolicy: "open" });
    expect(request.mock.calls.at(-1)![0]).not.toBe(first);
    expect(held.size).toBe(1);
  });

  it("retains the tab claim when a share's metadata update becomes obsolete", async () => {
    const { held, request, local } = hostRoomStorage();
    const room = { ...storedHost(), codeEntryPolicy: "open" as const };
    await writeHostRoom(room);
    const saved = local.get("piik:host-room:v1");
    let owns = true;
    const writing = writeHostRoom({ ...room, inviteUrl: "https://new.test/r/1234" }, () => owns);
    owns = false;
    expect(await writing).toBe(false);
    expect(held.size).toBe(1);
    expect(local.get("piik:host-room:v1")).toBe(saved);
    expect(await readHostRoom()).toMatchObject({ roomId: "1234", canonicalUrl: "https://share.test/r/1234" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("consumes a Viewer grant fragment once into room-scoped session storage", () => {
    const values = new Map<string, string>();
    const replaceState = vi.fn();
    const grant = `${"c".repeat(21)}g`;
    vi.stubGlobal("window", {
      location: new URL(`https://share.test/r/1234#v=${grant}`),
      history: { state: { navigation: 1 }, replaceState },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readViewerRoute()).toEqual({ roomId: "1234", viewerGrant: grant });
    expect(values.get("piik:viewer-grant:1234")).toBe(grant);
    expect(replaceState).toHaveBeenCalledWith(
      { navigation: 1 },
      "",
      "/r/1234",
    );
    expect(readViewerGrant("8")).toBeNull();
  });

  it("fails malformed Viewer fragments closed without leaking across rooms", () => {
    const values = new Map<string, string>();
    const oldGrant = `${"d".repeat(21)}w`;
    values.set("piik:viewer-grant:1234", oldGrant);
    vi.stubGlobal("window", {
      location: new URL("https://share.test/r/1234#v=malformed"),
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readViewerRoute()).toEqual({ roomId: "1234", invalidGrant: true });
    expect(readViewerGrant("1234")).toBeNull();
    replaceViewerInvite("1234", `https://share.test/r/1234#v=${"e".repeat(21)}Q`);
    expect(readViewerGrant("1234")).toBe(`${"e".repeat(21)}Q`);
    replaceViewerInvite("1234", `https://share.test/r/5678#v=${"f".repeat(21)}A`);
    expect(readViewerGrant("1234")).toBeNull();
    expect(readViewerGrant("5678")).toBeNull();
  });

  it("keeps the stored Viewer grant when the URL carries an unrelated fragment", () => {
    const values = new Map<string, string>();
    const grant = `${"d".repeat(21)}w`;
    values.set("piik:viewer-grant:1234", grant);
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: new URL("https://share.test/r/1234#:~:text=hello"),
      history: { state: null, replaceState },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readViewerRoute()).toEqual({ roomId: "1234", viewerGrant: grant });
    expect(readViewerGrant("1234")).toBe(grant);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("consumes renewed same-page invitations and ignores unrelated fragments", () => {
    const events = new EventTarget();
    const values = new Map<string, string>();
    const location = new URL("https://share.test/r/1234");
    vi.stubGlobal("window", {
      location,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => {
        location.href = new URL(url, location).href;
      } },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const changed = vi.fn();
    const stop = watchViewerInvites(changed);
    const first = `${"g".repeat(21)}g`;
    const renewed = `${"h".repeat(21)}w`;
    for (const grant of [first, renewed]) {
      location.hash = `v=${grant}`;
      events.dispatchEvent(new Event("hashchange"));
      expect(changed).toHaveBeenLastCalledWith({ roomId: "1234", viewerGrant: grant });
      expect(readViewerGrant("1234")).toBe(grant);
      expect(location.hash).toBe("");
    }
    location.hash = "section";
    events.dispatchEvent(new Event("hashchange"));
    expect(changed).toHaveBeenCalledTimes(2);
    location.hash = "v=invalid";
    events.dispatchEvent(new Event("hashchange"));
    expect(changed).toHaveBeenLastCalledWith({ roomId: "1234", invalidGrant: true });
    expect(readViewerGrant("1234")).toBeNull();
    stop();
    location.hash = `v=${renewed}`;
    events.dispatchEvent(new Event("hashchange"));
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("persists a rotated Viewer invitation across reload and clears it on revoke", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const firstGrant = `${"g".repeat(21)}g`;
    const rotatedGrant = `${"h".repeat(21)}w`;

    replaceViewerInvite("1234", `https://share.test/r/1234#v=${firstGrant}`);
    replaceViewerInvite("1234", `https://share.test/r/1234#v=${rotatedGrant}`);

    expect(readViewerGrant("1234")).toBe(rotatedGrant);
    expect(readViewerGrant("1234")).toBe(rotatedGrant);

    replaceViewerInvite("1234", null);
    expect(readViewerGrant("1234")).toBeNull();
  });

  it("keeps the latest rotated or revoked invite through Host re-authentication", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const oldInvite = `https://share.test/r/1234#v=${"i".repeat(21)}Q`;
    const rotatedInvite = `https://share.test/r/1234#v=${"j".repeat(21)}A`;
    replaceViewerInvite("1234", oldInvite);
    const activeRoom = {
      roomId: "1234",
      hostToken: "h".repeat(32),
      canonicalUrl: "https://share.test/r/1234",
      codeEntryPolicy: "open" as const,
      inviteUrl: oldInvite,
    };

    expect(
      mergeAuthenticatedHostRoom(
        { ...activeRoom, inviteUrl: rotatedInvite },
        activeRoom.roomId,
        "open",
      )?.inviteUrl,
    ).toBe(rotatedInvite);
    expect(
      mergeAuthenticatedHostRoom(
        { ...activeRoom, inviteUrl: null },
        activeRoom.roomId,
        "open",
      )?.inviteUrl,
    ).toBe(oldInvite);
    replaceViewerInvite(activeRoom.roomId, null);
    expect(
      mergeAuthenticatedHostRoom(
        { ...activeRoom, inviteUrl: null },
        activeRoom.roomId,
        "open",
      )?.inviteUrl,
    ).toBeNull();
  });

  it("keeps the latest preferred room without a client expiry", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    writePreferredRoom("4321");

    clearHostRoom();
    expect(readPreferredRoomId()).toBe("4321");
    expect(values.get("piik:host-room-preference:v1")).toBe(
      JSON.stringify({ roomId: "4321" }),
    );
  });

  it("removes a legacy Viewer grant from room-scoped session storage", () => {
    const values = new Map<string, string>([
      ["piik:viewer-grant:1234", `g1.1234.1.${"f".repeat(43)}`],
    ]);
    const removeItem = vi.fn((key: string) => values.delete(key));
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem,
      },
    });

    expect(readViewerGrant("1234")).toBeNull();
    expect(removeItem).toHaveBeenCalledWith("piik:viewer-grant:1234");
  });
});

describe("room codes", () => {
  it("accepts exactly four decimal digits without a leading zero", () => {
    expect(isValidRoomId("1000")).toBe(true);
    expect(isValidRoomId("9999")).toBe(true);
    expect(isValidRoomId("123")).toBe(false);
    expect(isValidRoomId("12345")).toBe(false);
    expect(isValidRoomId("0")).toBe(false);
    expect(isValidRoomId("0123")).toBe(false);
    expect(isValidRoomId("123a")).toBe(false);
    expect(roomRouteFromInput("1234")).toBe("/r/1234");
    expect(roomRouteFromInput(" 1234 ")).toBeNull();
    expect(roomRouteFromInput("１２３４")).toBeNull();
    expect(roomRouteFromInput("0123")).toBeNull();
  });

  it("drops only the stored grant for an explicit valid room-code entry", () => {
    const values = new Map<string, string>([
      ["piik:viewer-grant:1234", "AAAAAAAAAAAAAAAAAAAAAA"],
      ["piik:viewer-grant:5678", "AAAAAAAAAAAAAAAAAAAAAA"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(roomRouteForExplicitEntry("1234")).toBe("/r/1234");
    expect(values.has("piik:viewer-grant:1234")).toBe(false);
    expect(values.has("piik:viewer-grant:5678")).toBe(true);

    expect(roomRouteForExplicitEntry(" 5678 ")).toBeNull();
    expect(values.has("piik:viewer-grant:5678")).toBe(true);
  });

  it("classifies routes without normalizing malformed room input", () => {
    expect(parseAppRoute("/client")).toEqual({ kind: "client" });
    expect(parseAppRoute("/client/")).toEqual({ kind: "client" });
    expect(parseAppRoute("/")).toEqual({ kind: "host" });
    expect(parseAppRoute("/join")).toEqual({ kind: "join" });
    expect(parseAppRoute("/join/")).toEqual({ kind: "join" });
    expect(parseAppRoute("/r/1000")).toEqual({
      kind: "viewer",
      roomId: "1000",
    });
    expect(parseAppRoute("/r/9999/")).toEqual({
      kind: "viewer",
      roomId: "9999",
    });
    for (const pathname of [
      "/r",
      "/r/",
      "/r/123",
      "/r/12345",
      "/r/0000",
      "/r/abcd",
      "/r/１２３４",
      "/r/1234/extra",
    ]) {
      expect(parseAppRoute(pathname)).toEqual({ kind: "malformed-room" });
    }
    expect(parseAppRoute("/other")).toEqual({ kind: "unknown" });
  });

  it("consumes one exact App access bootstrap without retaining it in the URL", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: `#client-access=${"a".repeat(32)}`,
        pathname: "/",
        search: "?mode=local",
      },
      history: { state: { current: true }, replaceState },
    });

    expect(takeClientLaunchBootstrap()).toMatchObject({
      accessToken: "a".repeat(32),
      launchedByClient: false,
    });
    expect(replaceState).toHaveBeenCalledWith(
      { current: true },
      "",
      "/?mode=local",
    );
  });

  it("removes an empty App bootstrap without authenticating it", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: "#client-access=", pathname: "/", search: "" },
      history: { state: null, replaceState },
    });

    expect(takeClientLaunchBootstrap().accessToken).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it.each(["x", "中文", " ", "  中文 +&  ", "x".repeat(256)])("preserves a chosen App access value: %s", (password) => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: `#${new URLSearchParams({ "client-access": password })}`,
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState },
    });

    expect(takeClientLaunchBootstrap().accessToken).toBe(password);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("consumes the App launch marker from a server-private fragment", () => {
    const replaceState = vi.fn();
    const session = new Map<string, string>();
    vi.stubGlobal("window", {
      location: {
        hash: `#client-access=${"a".repeat(32)}&piik-client=1&retained=yes`,
        pathname: "/",
        search: "?room=6020",
      },
      history: { state: null, replaceState },
      localStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
      },
    });

    expect(takeClientLaunchBootstrap()).toEqual({
      accessToken: "a".repeat(32),
      launchedByClient: true,
      presentation: null,
    });
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?room=6020#retained=yes",
    );

    window.location.hash = "";
    expect(takeClientLaunchBootstrap()).toEqual({
      accessToken: null,
      launchedByClient: true,
      presentation: null,
    });
  });

  it.each([
    { lang: "zh", vis: false, theme: "light" },
    { lang: "en", vis: true, theme: null },
  ] as const)("carries launcher presentation across origins: %j", (presentation) => {
    const target = new URL(clientLaunchURL(
      "https://site.example/?room=9527#piik-client=1&client-access=a%2Bb%26c%3Fd%3De&retained=yes",
      presentation,
    ));
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: target,
      history: { state: null, replaceState },
    });

    expect(target.origin).toBe("https://site.example");
    expect(takeClientLaunchBootstrap()).toEqual({
      accessToken: "a+b&c?d=e",
      launchedByClient: true,
      presentation: { ...presentation, explicit: [] },
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?room=9527#retained=yes");
  });

  it.each([
    ["piik-lang=zh&piik-mode=text&piik-theme=light", null],
    ["piik-client=1&piik-lang=other&piik-mode=text&piik-theme=light", { vis: false, theme: "light", explicit: [] }],
    ["piik-client=1&piik-lang=zh&piik-mode=other&piik-theme=light", { lang: "zh", theme: "light", explicit: [] }],
    ["piik-client=1&piik-lang=zh&piik-mode=text&piik-theme=other", { lang: "zh", vis: false, explicit: [] }],
  ])("ignores invalid preference fields without losing App access: %s", (fragment, presentation) => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: `#${fragment}&client-access=${"a".repeat(32)}`, pathname: "/", search: "" },
      history: { state: null, replaceState },
    });
    expect(takeClientLaunchBootstrap()).toMatchObject({
      accessToken: "a".repeat(32),
      presentation,
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});

describe("WebRTC stats parsing", () => {
  it("sums sender layers and rebases incomplete bitrate windows", () => {
    const accumulator = createNativeSenderQualityAccumulator();
    const sample = (
      timestamp: number,
      bytesByLayer: Readonly<Record<string, number>>,
    ): number | null => {
      const records: Array<[string, Record<string, unknown>]> = [
        [
          "source",
          {
            id: "source",
            type: "media-source",
            timestamp,
            trackIdentifier: "track",
          },
        ],
      ];
      for (const [id, bytesSent] of Object.entries(bytesByLayer)) {
        records.push([
          id,
          {
            id,
            type: "outbound-rtp",
            kind: "video",
            timestamp,
            mediaSourceId: "source",
            bytesSent,
            framesEncoded: timestamp / 20,
            qualityLimitationReason: "none",
            qualityLimitationDurations: {
              none: timestamp / 1_000,
              bandwidth: 0,
              cpu: 0,
              other: 0,
            },
          },
        ]);
      }
      return collectNativeSenderQualityFromReport(
        new Map(records) as unknown as RTCStatsReport,
        "track",
        accumulator,
      ).bitrateKbps;
    };

    expect(sample(1_000, { low: 10_000, high: 20_000 })).toBeNull();
    expect(sample(3_000, { low: 110_000, high: 220_000 })).toBe(1_200);
    expect(
      sample(5_000, { low: 210_000, high: 420_000, mid: 50_000 }),
    ).toBeNull();
    expect(
      sample(7_000, { low: 310_000, high: 620_000, mid: 150_000 }),
    ).toBe(1_600);
    expect(
      sample(9_000, { low: 10_000, high: 820_000, mid: 250_000 }),
    ).toBeNull();
    expect(
      sample(11_000, {
        low: 110_000,
        high: 1_020_000,
        mid: 350_000,
      }),
    ).toBe(1_600);
  });

  it("binds media, remote evidence, transport, and pair without guessing", async () => {
    const entry = (
      id: string,
      type: string,
      values: Record<string, unknown>,
    ): [string, Record<string, unknown>] => [
      id,
      { id, type, timestamp: 2_000, ...values },
    ];
    const report = new Map<string, Record<string, unknown>>([
      entry("transport-a", "transport", {
        selectedCandidatePairId: "pair-a",
      }),
      entry("transport-z", "transport", {
        selectedCandidatePairId: "pair-z",
      }),
      entry("pair-a", "candidate-pair", {
        transportId: "transport-a",
        localCandidateId: "local-a",
        remoteCandidateId: "remote-candidate-a",
        currentRoundTripTime: 0.02,
      }),
      entry("pair-z", "candidate-pair", {
        transportId: "transport-z",
        localCandidateId: "local-z",
        remoteCandidateId: "remote-candidate-z",
      }),
      entry("local-a", "local-candidate", {
        candidateType: "host",
        protocol: "udp",
        address: "192.0.2.10",
        port: 50_000,
      }),
      entry("remote-candidate-a", "remote-candidate", {
        candidateType: "srflx",
        foundation: "sp1",
        protocol: "udp",
        address: "2001:db8::10",
        port: 50_001,
      }),
      entry("local-z", "local-candidate", {
        candidateType: "relay",
        protocol: "tcp",
      }),
      entry("remote-candidate-z", "remote-candidate", {
        candidateType: "relay",
        protocol: "tcp",
      }),
      entry("outbound-a", "outbound-rtp", {
        kind: "video",
        ssrc: 111,
        mid: "0",
        transportId: "transport-a",
        mediaSourceId: "source-a",
        remoteId: "remote-inbound-a",
        codecId: "codec-a",
        rid: "main",
        scalabilityMode: "L2T3_KEY",
        bytesSent: 2_000,
        framesEncoded: 60,
        totalEncodeTime: 0.3,
        encoderImplementation: "ExternalEncoder",
        powerEfficientEncoder: true,
      }),
      entry("outbound-z", "outbound-rtp", {
        kind: "video",
        ssrc: 999,
        transportId: "transport-z",
        mediaSourceId: "source-z",
        remoteId: "remote-inbound-z",
        codecId: "codec-z",
        bytesSent: 99_000,
        framesEncoded: 99,
      }),
      entry("source-a", "media-source", {
        kind: "video",
        trackIdentifier: "capture-track-a",
        framesPerSecond: 58.5,
      }),
      entry("source-z", "media-source", {
        kind: "video",
        trackIdentifier: "capture-track-z",
      }),
      entry("remote-inbound-a", "remote-inbound-rtp", {
        kind: "video",
        packetsLost: 2,
        jitter: 0.004,
      }),
      entry("remote-inbound-z", "remote-inbound-rtp", {
        kind: "video",
        packetsLost: 999,
        jitter: 0.9,
      }),
      entry("codec-a", "codec", {
        transportId: "transport-a",
        mimeType: "video/H264",
        sdpFmtpLine:
          "profile-level-id=42E01F; packetization-mode=1; " +
          "level-asymmetry-allowed=1; sprop-parameter-sets=do-not-expose; " +
          "x-google-start-bitrate=99999",
      }),
      entry("codec-z", "codec", {
        transportId: "transport-z",
        mimeType: "video/VP9",
        sdpFmtpLine: "profile-id=3; max-fr=15; max-fs=1200",
      }),
    ]);
    const connection = {
      getStats: async () => report as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;

    const accumulator = createStatsAccumulator();
    const metrics = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );

    expect(metrics).toMatchObject({
      sampleTimestampMs: 2_000,
      sampleWindowMs: null,
      rtpStatsId: "outbound-a",
      rtpSsrc: 111,
      rtpMid: "0",
      rtpRid: "main",
      trackIdentifier: "capture-track-a",
      mediaSourceFramesPerSecond: 58.5,
      selectedCandidatePairId: "pair-a",
      path: "direct",
      natTraversalPath: "predicted",
      iceProtocol: "udp",
      localCandidateAddress: "192.0.2.10",
      localCandidatePort: 50_000,
      remoteCandidateAddress: "2001:db8::10",
      remoteCandidatePort: 50_001,
      packetsLost: 2,
      jitterMs: 4,
      rttMs: 20,
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      codecParameters:
        "packetization-mode=1; level-asymmetry-allowed=1",
      scalabilityMode: "L2T3_KEY",
      encoderImplementation: "ExternalEncoder",
      powerEfficientEncoder: true,
      intervalFramesEncoded: null,
      intervalEncodeTimeMs: null,
    });
    expect(JSON.stringify(metrics)).not.toContain("sprop-parameter-sets");
    expect(JSON.stringify(metrics)).not.toContain("x-google-start-bitrate");

    report.get("remote-candidate-a")!.address = null;
    delete report.get("remote-candidate-a")!.port;
    expect(
      await collectConnectionMetrics(connection, "send", accumulator, {
        trackIdentifier: "capture-track-a",
      }),
    ).toMatchObject({
      selectedCandidatePairId: "pair-a",
      localCandidateAddress: "192.0.2.10",
      localCandidatePort: 50_000,
      remoteCandidateAddress: null,
      remoteCandidatePort: null,
    });
    report.get("remote-candidate-a")!.address = "2001:db8::10";
    report.get("remote-candidate-a")!.port = 50_001;
    report.get("remote-candidate-a")!.foundation = "ordinary";
    expect(
      await collectConnectionMetrics(connection, "send", accumulator, {
        trackIdentifier: "capture-track-a",
      }),
    ).toMatchObject({ natTraversalPath: "ordinary" });

    report.get("transport-a")!.selectedCandidatePairId = "pair-z";
    const wrongTransportPair = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(wrongTransportPair).toMatchObject({
      rtpStatsId: "outbound-a",
      selectedCandidatePairId: null,
      path: "unknown",
    });

    report.get("transport-a")!.selectedCandidatePairId = "pair-a";
    report.get("codec-a")!.transportId = "transport-z";
    const wrongTransportCodec = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(wrongTransportCodec).toMatchObject({
      rtpStatsId: "outbound-a",
      codec: null,
      codecProfile: null,
      codecParameters: null,
    });
    report.get("codec-a")!.transportId = "transport-a";

    report.get("local-a")!.type = "remote-candidate";
    report.get("remote-candidate-a")!.type = "local-candidate";
    const malformedCandidateReferences = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(malformedCandidateReferences).toMatchObject({
      selectedCandidatePairId: null,
      path: "unknown",
      localCandidateType: null,
      remoteCandidateType: null,
    });
    report.get("local-a")!.type = "local-candidate";
    report.get("remote-candidate-a")!.type = "remote-candidate";

    delete report.get("outbound-a")!.transportId;
    const unboundTransport = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(unboundTransport).toMatchObject({
      rtpStatsId: "outbound-a",
      selectedCandidatePairId: null,
      path: "unknown",
      codec: null,
      codecProfile: null,
      codecParameters: null,
    });
    report.get("outbound-a")!.transportId = "transport-a";

    report.set("outbound-a-layer-2", {
      id: "outbound-a-layer-2",
      type: "outbound-rtp",
      timestamp: 3_000,
      kind: "video",
      ssrc: 112,
      transportId: "transport-a",
      mediaSourceId: "source-a",
      bytesSent: 3_000,
      framesEncoded: 90,
    });
    const ambiguous = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(ambiguous).toMatchObject({
      rtpStatsId: null,
      selectedCandidatePairId: null,
      packetsLost: null,
      codec: null,
      codecProfile: null,
      codecParameters: null,
      scalabilityMode: null,
    });
  });

  it.each([
    {
      mimeType: "video/VP8",
      fmtp: "max-fr=60; max-fs=3600",
      profile: null,
      parameters: "max-fr=60; max-fs=3600",
    },
    {
      mimeType: "video/VP9",
      fmtp: "profile-id=2; max-fr=60; max-fs=3600",
      profile: "profile-id=2",
      parameters: "max-fr=60; max-fs=3600",
    },
    {
      mimeType: "video/AV1",
      fmtp: "profile=1; level-idx=8; tier=0",
      profile: "profile=1",
      parameters: "level-idx=8; tier=0",
    },
    {
      mimeType: "video/H264",
      fmtp:
        "profile-level-id=42e01f; profile-level-id=invalid; " +
        "packetization-mode=1",
      profile: null,
      parameters: "packetization-mode=1",
    },
    {
      mimeType: "video/H264",
      fmtp: `profile-level-id=42e01f; ignored=${"x".repeat(2_048)}`,
      profile: null,
      parameters: null,
    },
    {
      mimeType: "video/H264",
      fmtp: [
        "profile-level-id=42e01f",
        ...Array.from({ length: 32 }, (_, index) => `ignored-${index}=1`),
      ].join(";"),
      profile: null,
      parameters: null,
    },
    {
      mimeType: "video/H265",
      fmtp: "profile-id=1; tier-flag=0; level-id=93",
      profile: null,
      parameters: null,
    },
  ])(
    "derives only allowlisted $mimeType format parameters",
    async ({ mimeType, fmtp, profile, parameters }) => {
      const report = new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp: 1_000 },
        ],
        [
          "outbound",
          {
            id: "outbound",
            type: "outbound-rtp",
            timestamp: 1_000,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "codec",
            bytesSent: 1_000,
            framesEncoded: 30,
          },
        ],
        [
          "codec",
          {
            id: "codec",
            type: "codec",
            timestamp: 1_000,
            transportId: "transport",
            mimeType,
            sdpFmtpLine: fmtp,
          },
        ],
      ]) as unknown as RTCStatsReport;
      const connection = {
        getStats: async () => report,
      } as unknown as RTCPeerConnection;

      const metrics = await collectConnectionMetrics(
        connection,
        "send",
        createStatsAccumulator(),
      );
      expect(metrics).toMatchObject({
        codec: mimeType,
        codecProfile: profile,
        codecParameters: parameters,
        scalabilityMode: null,
      });
      expect(
        qualityEvidenceWindowFromMetrics({
          ...metrics,
          sampleWindowMs: 2_000,
        })?.metrics,
      ).toMatchObject({
        codec: mimeType,
        codecProfile: profile,
        codecParameters: parameters,
      });
    },
  );

  it("rebases sender retransmission deltas after counter rollback", async () => {
    const outbound = (
      timestamp: number,
      retransmittedPacketsSent: number,
      retransmittedBytesSent: number,
      packetsSent: number,
      packetsLost: number,
    ) =>
      new Map<string, unknown>([
        [
          "outbound",
          {
            id: "outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            remoteId: "remote-inbound",
            bytesSent: timestamp * 10,
            framesEncoded: timestamp / 10,
            packetsSent,
            retransmittedPacketsSent,
            retransmittedBytesSent,
          },
        ],
        [
          "remote-inbound",
          {
            id: "remote-inbound",
            type: "remote-inbound-rtp",
            timestamp,
            kind: "video",
            packetsLost,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      outbound(1_000, 2, 200, 100, 1),
      outbound(2_000, 5, 800, 400, 3),
      outbound(3_000, 1, 100, 50, 1),
      outbound(4_000, 4, 700, 350, 4),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();
    const sample = () =>
      collectConnectionMetrics(connection, "send", accumulator);
    const first = await sample();
    const stable = await sample();
    const reset = await sample();
    const afterReset = await sample();

    expect(first.intervalRetransmittedPackets).toBeNull();
    expect(stable).toMatchObject({
      intervalPacketsSent: 300,
      intervalPacketsLost: 2,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
    expect(reset).toMatchObject({
      intervalPacketsSent: null,
      intervalPacketsLost: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterReset).toMatchObject({
      intervalPacketsSent: 300,
      intervalPacketsLost: 3,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
  });

  it("keeps an out-of-contract relay candidate unclassified", async () => {
    const report = new Map<string, Record<string, unknown>>([
      [
        "transport",
        {
          id: "transport",
          type: "transport",
          timestamp: 2_000,
          selectedCandidatePairId: "pair",
        },
      ],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          timestamp: 2_000,
          transportId: "transport",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
        },
      ],
      [
        "local",
        {
          id: "local",
          type: "local-candidate",
          timestamp: 2_000,
          candidateType: "relay",
          protocol: "udp",
        },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          timestamp: 2_000,
          candidateType: "host",
          protocol: "udp",
        },
      ],
      [
        "inbound",
        {
          id: "inbound",
          type: "inbound-rtp",
          timestamp: 2_000,
          kind: "video",
          transportId: "transport",
          bytesReceived: 2_000,
          framesDecoded: 100,
          totalDecodeTime: 0.5,
        },
      ],
    ]);
    const secondReport = new Map(report);
    secondReport.set("inbound", {
      id: "inbound",
      type: "inbound-rtp",
      timestamp: 4_000,
      kind: "video",
      transportId: "transport",
      bytesReceived: 4_000,
      framesDecoded: 150,
      totalDecodeTime: 1.5,
    });
    const reports = [report, secondReport];
    const connection = {
      getStats: async () =>
        reports.shift() as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    const firstMetrics = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const metrics = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(firstMetrics.intervalDecodeMs).toBeNull();
    expect(metrics).toMatchObject({
      path: "unknown",
      iceProtocol: "udp",
      localCandidateType: "relay",
      remoteCandidateType: "host",
      intervalDecodeMs: 20,
    });
  });

  it("rebases interval metrics when the RTP stream or its counters reset", async () => {
    const inbound = (
      id: string,
      timestamp: number,
      bytesReceived: number,
      framesDecoded: number,
      totalDecodeTime: number,
    ) =>
      new Map<string, unknown>([
        [
          id,
          {
            id,
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            bytesReceived,
            framesDecoded,
            totalDecodeTime,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound("inbound-a", 1_000, 10_000, 100, 0.5),
      inbound("inbound-b", 2_000, 20_000, 150, 1.5),
      inbound("inbound-b", 3_000, 22_000, 160, 1.7),
      inbound("inbound-b", 4_000, 1_000, 10, 0.1),
      inbound("inbound-b", 5_000, 3_000, 20, 0.3),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "receive", accumulator);
    const streamChanged = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const afterStreamChange = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const countersReset = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const afterCounterReset = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(streamChanged).toMatchObject({
      bitrateKbps: null,
      framesPerSecond: null,
      intervalDecodeMs: null,
    });
    expect(afterStreamChange).toMatchObject({
      bitrateKbps: 16,
      framesPerSecond: 10,
    });
    expect(afterStreamChange.intervalDecodeMs).toBeCloseTo(20);
    expect(countersReset).toMatchObject({
      bitrateKbps: null,
      framesPerSecond: null,
      intervalDecodeMs: null,
    });
    expect(afterCounterReset).toMatchObject({
      bitrateKbps: 16,
      framesPerSecond: 10,
    });
    expect(afterCounterReset.intervalDecodeMs).toBeCloseTo(20);
  });

  it("rebases receiver event deltas on SSRC changes and counter resets", async () => {
    const inbound = (
      timestamp: number,
      ssrc: number,
      framesDropped: number,
      freezeCount: number,
      totalFreezesDuration: number,
      pauseCount: number,
      totalPausesDuration: number,
      retransmittedPacketsReceived: number,
      retransmittedBytesReceived: number,
    ) =>
      new Map<string, unknown>([
        [
          "inbound",
          {
            id: "inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc,
            bytesReceived: timestamp * 10,
            framesDecoded: timestamp / 10,
            framesDropped,
            freezeCount,
            totalFreezesDuration,
            pauseCount,
            totalPausesDuration,
            retransmittedPacketsReceived,
            retransmittedBytesReceived,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound(1_000, 101, 2, 1, 0.25, 0, 0, 3, 300),
      inbound(2_000, 101, 5, 2, 2.75, 1, 5.5, 7, 900),
      inbound(3_000, 202, 20, 8, 4, 3, 16, 30, 4_000),
      inbound(4_000, 202, 22, 9, 6.25, 4, 21.5, 33, 4_600),
      inbound(5_000, 202, 1, 0, 0.25, 0, 0.25, 2, 200),
      inbound(6_000, 202, 4, 1, 2.5, 1, 6.25, 6, 1_000),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();
    const sample = () =>
      collectConnectionMetrics(connection, "receive", accumulator);
    const first = await sample();
    const stable = await sample();
    const changedSsrc = await sample();
    const afterSsrcChange = await sample();
    const reset = await sample();
    const afterReset = await sample();

    expect(first).toMatchObject({
      sampleWindowMs: null,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalPauseCount: null,
      intervalPauseDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(stable).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 3,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 2_500,
      intervalPauseCount: 1,
      intervalPauseDurationMs: 5_500,
      intervalRetransmittedPackets: 4,
      intervalRetransmittedBytes: 600,
    });
    expect(changedSsrc).toMatchObject({
      rtpSsrc: 202,
      sampleWindowMs: null,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalPauseCount: null,
      intervalPauseDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterSsrcChange).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 2,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 2_250,
      intervalPauseCount: 1,
      intervalPauseDurationMs: 5_500,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
    expect(reset).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalPauseCount: null,
      intervalPauseDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterReset).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 3,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 2_250,
      intervalPauseCount: 1,
      intervalPauseDurationMs: 6_000,
      intervalRetransmittedPackets: 4,
      intervalRetransmittedBytes: 800,
    });
  });

  it("keeps unavailable pause counters unknown and receive-only", async () => {
    const report = (
      type: "inbound-rtp" | "outbound-rtp",
      timestamp: number,
    ) =>
      new Map<string, unknown>([
        [
          "video",
          {
            id: "video",
            type,
            timestamp,
            kind: "video",
            ssrc: 101,
            ...(type === "inbound-rtp"
              ? { bytesReceived: timestamp, framesDecoded: timestamp / 100 }
              : {
                  bytesSent: timestamp,
                  framesEncoded: timestamp / 100,
                  pauseCount: timestamp / 1_000,
                  totalPausesDuration: timestamp / 1_000,
                }),
          },
        ],
      ]) as unknown as RTCStatsReport;

    const receiveAccumulator = createStatsAccumulator();
    collectConnectionMetricsFromReport(
      report("inbound-rtp", 1_000),
      "receive",
      receiveAccumulator,
    );
    const receive = collectConnectionMetricsFromReport(
      report("inbound-rtp", 2_000),
      "receive",
      receiveAccumulator,
    );
    expect(receive).toMatchObject({
      intervalPauseCount: null,
      intervalPauseDurationMs: null,
    });

    const sendAccumulator = createStatsAccumulator();
    collectConnectionMetricsFromReport(
      report("outbound-rtp", 1_000),
      "send",
      sendAccumulator,
    );
    const send = collectConnectionMetricsFromReport(
      report("outbound-rtp", 2_000),
      "send",
      sendAccumulator,
    );
    expect(send).toMatchObject({
      intervalPauseCount: null,
      intervalPauseDurationMs: null,
    });
  });

  it("derives a bounded inbound C window from adjacent RTP counters", async () => {
    const inbound = (
      timestamp: number,
      packetsReceived: number,
      packetsLost: number,
      framesDecoded: number,
      totalDecodeTime: number,
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "codec",
          {
            id: "codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "video/H264",
            sdpFmtpLine:
              "profile-level-id=42e01f; packetization-mode=1; " +
              "sprop-parameter-sets=must-not-leave-stats",
          },
        ],
        [
          "inbound",
          {
            id: "inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "codec",
            bytesReceived: timestamp * 10,
            packetsReceived,
            packetsLost,
            framesDecoded,
            framesDropped: 3,
            freezeCount: 1,
            totalFreezesDuration: 0.25,
            totalDecodeTime,
            frameWidth: 1_920,
            frameHeight: 1_080,
            scalabilityMode: "L3T3_KEY",
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound(1_000, 1_000, 10, 60, 0.12),
      inbound(3_000, 2_500, 12, 180, 0.42),
      inbound(5_000, 4_000, 11, 300, 0.72),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "receive", accumulator);
    const stable = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const correctedLoss = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(stable).toMatchObject({
      sampleWindowMs: 2_000,
      frameWidth: 1_920,
      frameHeight: 1_080,
      intervalPacketsReceived: 1_500,
      intervalPacketsLost: 2,
      packetLossPercent: (2 / 1_502) * 100,
      intervalFramesDecoded: 120,
      intervalDecodeMs: 2.5,
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      codecParameters: "packetization-mode=1",
      scalabilityMode: null,
    });
    expect(JSON.stringify(stable)).not.toContain("sprop-parameter-sets");
    expect(correctedLoss).toMatchObject({
      intervalPacketsLost: null,
      packetLossPercent: null,
    });
  });

  it("reports verified inbound audio codec and interval transport facts", async () => {
    const report = (
      timestamp: number,
      videoPacketsReceived: number,
      videoPacketsLost: number,
      audioBytesReceived: number,
      audioPacketsReceived: number,
      audioPacketsLost: number,
      audioCodecTransportId = "transport",
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "video-codec",
          {
            id: "video-codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "video/VP8",
          },
        ],
        [
          "audio-codec",
          {
            id: "audio-codec",
            type: "codec",
            timestamp,
            transportId: audioCodecTransportId,
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
            sdpFmtpLine: "minptime=10;useinbandfec=1",
          },
        ],
        [
          "video-inbound",
          {
            id: "video-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "video-codec",
            bytesReceived: timestamp * 10,
            packetsReceived: videoPacketsReceived,
            packetsLost: videoPacketsLost,
            framesDecoded: timestamp / 20,
          },
        ],
        [
          "audio-inbound",
          {
            id: "audio-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "audio",
            ssrc: 202,
            trackIdentifier: "shared-audio",
            transportId: "transport",
            codecId: "audio-codec",
            bytesReceived: audioBytesReceived,
            packetsReceived: audioPacketsReceived,
            packetsLost: audioPacketsLost,
            jitter: 0.003,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      report(1_000, 100, 5, 10_000, 1_000, 5),
      report(3_000, 190, 15, 50_000, 1_180, 10),
      report(5_000, 190, 15, 50_000, 1_180, 10, "other-transport"),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    const first = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const stable = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const zeroDenominator = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(first).toMatchObject({
      packetLossPercent: null,
      audioBitrateKbps: null,
      audioPacketLossPercent: null,
      audioJitterMs: 3,
      audioCodec: "audio/opus",
      audioCodecClockRate: 48_000,
      audioCodecChannels: 2,
      audioCodecParameters: "minptime=10;useinbandfec=1",
    });
    expect(stable.packetLossPercent).toBeCloseTo(10);
    expect(stable.audioBitrateKbps).toBeCloseTo(160);
    expect(stable.audioPacketLossPercent).toBeCloseTo((5 / 185) * 100);
    expect(zeroDenominator).toMatchObject({
      packetLossPercent: null,
      audioBitrateKbps: 0,
      audioPacketLossPercent: null,
      audioCodec: null,
      audioCodecClockRate: null,
      audioCodecChannels: null,
      audioCodecParameters: null,
    });
  });

  it("derives local inbound playout, jitter-buffer, and concealment evidence safely", async () => {
    const report = (
      timestamp: number,
      video: Record<string, unknown> = {},
      audio: Record<string, unknown> = {},
    ) =>
      new Map<string, unknown>([
        [
          "video-inbound",
          {
            id: "video-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            trackIdentifier: "shared-video",
            bytesReceived: timestamp * 10,
            framesDecoded: timestamp / 20,
            ...video,
          },
        ],
        [
          "audio-inbound",
          {
            id: "audio-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "audio",
            ssrc: 202,
            trackIdentifier: "shared-audio",
            bytesReceived: timestamp * 2,
            ...audio,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      report(
        1_000,
        {
          estimatedPlayoutTimestamp: 10_000,
          jitterBufferDelay: 1.2,
          jitterBufferEmittedCount: 60,
        },
        {
          estimatedPlayoutTimestamp: 10_012.5,
          jitterBufferDelay: 960,
          jitterBufferEmittedCount: 48_000,
          totalSamplesReceived: 48_000,
          concealedSamples: 480,
          concealmentEvents: 2,
        },
      ),
      report(
        3_000,
        {
          estimatedPlayoutTimestamp: 12_000,
          jitterBufferDelay: 4.2,
          jitterBufferEmittedCount: 180,
        },
        {
          estimatedPlayoutTimestamp: 12_008.5,
          jitterBufferDelay: 3_120,
          jitterBufferEmittedCount: 144_000,
          totalSamplesReceived: 144_000,
          concealedSamples: 1_440,
          concealmentEvents: 5,
        },
      ),
      report(
        5_000,
        {
          estimatedPlayoutTimestamp: 14_000,
          jitterBufferDelay: 7.8,
          jitterBufferEmittedCount: 300,
        },
        {
          ssrc: 303,
          trackIdentifier: "replacement-audio",
          estimatedPlayoutTimestamp: 13_997,
          jitterBufferDelay: 2_000,
          jitterBufferEmittedCount: 96_000,
          totalSamplesReceived: 96_000,
          concealedSamples: 5_000,
          concealmentEvents: 30,
        },
      ),
      report(
        7_000,
        {
          estimatedPlayoutTimestamp: 16_000,
          jitterBufferDelay: 1,
          jitterBufferEmittedCount: 20,
        },
        {
          ssrc: 303,
          trackIdentifier: "replacement-audio",
          estimatedPlayoutTimestamp: 15_996,
          jitterBufferDelay: 480,
          jitterBufferEmittedCount: 24_000,
          totalSamplesReceived: 24_000,
          concealedSamples: 100,
          concealmentEvents: 1,
        },
      ),
      report(9_000, {}, { ssrc: 303, trackIdentifier: "replacement-audio" }),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    const first = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const stable = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const changedAudio = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const reset = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const unsupported = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(first).toMatchObject({
      audioVideoPlayoutDeltaMs: 12.5,
      videoJitterBufferDelayMs: null,
      audioJitterBufferDelayMs: null,
      audioConcealedSamplesPercent: null,
      intervalAudioConcealmentEvents: null,
    });
    expect(stable.audioVideoPlayoutDeltaMs).toBeCloseTo(8.5);
    expect(stable.videoJitterBufferDelayMs).toBeCloseTo(25);
    expect(stable.audioJitterBufferDelayMs).toBeCloseTo(22.5);
    expect(stable.audioConcealedSamplesPercent).toBeCloseTo(1);
    expect(stable.intervalAudioConcealmentEvents).toBe(3);
    expect(changedAudio).toMatchObject({
      audioVideoPlayoutDeltaMs: -3,
      audioJitterBufferDelayMs: null,
      audioConcealedSamplesPercent: null,
      intervalAudioConcealmentEvents: null,
    });
    expect(changedAudio.videoJitterBufferDelayMs).toBeCloseTo(30);
    expect(reset).toMatchObject({
      audioVideoPlayoutDeltaMs: -4,
      videoJitterBufferDelayMs: null,
      audioJitterBufferDelayMs: null,
      audioConcealedSamplesPercent: null,
      intervalAudioConcealmentEvents: null,
    });
    expect(unsupported).toMatchObject({
      audioVideoPlayoutDeltaMs: null,
      videoJitterBufferDelayMs: null,
      audioJitterBufferDelayMs: null,
      audioConcealedSamplesPercent: null,
      intervalAudioConcealmentEvents: null,
    });
  });

  it("uses linked remote inbound counters for outbound audio loss", async () => {
    const report = (
      timestamp: number,
      audioBytesSent: number,
      packetsReceived: number | undefined,
      packetsLost: number | undefined,
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "video-outbound",
          {
            id: "video-outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            bytesSent: timestamp * 10,
            packetsSent: timestamp / 10,
            framesEncoded: timestamp / 20,
          },
        ],
        [
          "audio-codec",
          {
            id: "audio-codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
          },
        ],
        [
          "audio-outbound",
          {
            id: "audio-outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "audio",
            ssrc: 202,
            transportId: "transport",
            codecId: "audio-codec",
            remoteId: "audio-remote-inbound",
            bytesSent: audioBytesSent,
          },
        ],
        [
          "audio-remote-inbound",
          {
            id: "audio-remote-inbound",
            type: "remote-inbound-rtp",
            timestamp,
            kind: "audio",
            packetsReceived,
            packetsLost,
            jitter: 0.004,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const firstReport = report(1_000, 20_000, 500, 1);
    (firstReport as unknown as Map<string, unknown>).delete(
      "audio-remote-inbound",
    );
    const reports = [
      firstReport,
      report(3_000, 50_000, 500, 1),
      report(5_000, 80_000, 650, 4),
      report(7_000, 110_000, 50, 1),
      report(9_000, 140_000, 200, undefined),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "send", accumulator);
    const remoteAppeared = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const stable = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const reset = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const missing = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );

    expect(remoteAppeared).toMatchObject({
      audioBitrateKbps: 120,
      audioPacketLossPercent: null,
    });
    expect(stable).toMatchObject({
      audioBitrateKbps: 120,
      audioJitterMs: 4,
      audioCodec: "audio/opus",
      audioCodecClockRate: 48_000,
      audioCodecChannels: 2,
    });
    expect(stable.audioPacketLossPercent).toBeCloseTo((3 / 153) * 100);
    expect(reset.audioPacketLossPercent).toBeNull();
    expect(missing.audioPacketLossPercent).toBeNull();
  });
});
