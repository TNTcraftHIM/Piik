import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("Browser WASM saves room consent, keeps Read separate and derives fresh service socket proof", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  const [ownerUser, viewerUser, operatorUser, owner, viewer, service, binding, ownerSocket, serviceSocket] = Array.from({ length: 9 }, () => crypto.randomUUID());
  const settings = { name: "Private", icon: "couch", access: "private", hidden: true };
  const policy = JSON.parse(rust.create_room_policy(JSON.stringify({ ...settings, id: "transit-adapter", creatorId: ownerUser, password: null })));
  expect(policy.allowServiceRelay).toBe(false);
  policy.grants.push(viewerUser);
  const host = new rust.RoomHost(JSON.stringify(policy));
  const endpoints = Object.fromEntries([[owner, ownerUser], [viewer, viewerUser], [service, operatorUser]].map(([session, user]) => [session, { member: { userId: user }, connected: true, signingKey: Array(32).fill(0) }]));
  let revision = 0;
  let serviceEndpoint: { sessionId: string; connectionId: string } | null = { sessionId: service, connectionId: serviceSocket };
  const turn = (action: object, failedPairs: object[] = [], commit = true) => {
    const work = JSON.parse(host.dispatch(JSON.stringify({ now: 100, bindingId: binding, hostSessionId: owner, revision: ++revision, endpoints, serviceEndpoint, failedPairs, action })));
    expect(work.history).toBeNull();
    return JSON.parse(commit ? host.finish() : host.abort("storage_failed"));
  };
  const context = { connection: ownerSocket, sessionId: owner, requestId: "preference", now: 100 };
  const preference = (allowed: boolean) => ({ type: "command", context, command: { type: "update_room", roomId: policy.id, ...settings, allowServiceRelay: allowed } });
  try {
    turn({ type: "sync" });
    expect(turn(preference(true), [], false).reply.result).toEqual({ type: "error", code: "storage_failed" });
    expect(JSON.parse(host.policy()).allowServiceRelay).toBe(false);
    expect(turn(preference(true)).reply.result.type).toBe("done");
    expect(JSON.parse(host.policy()).allowServiceRelay).toBe(true);
    expect(JSON.parse(host.summary())).not.toHaveProperty("allowServiceRelay");
    turn({ type: "command", context: { ...context, sessionId: viewer }, command: { type: "voice", roomId: policy.id, joined: true, muted: true, deafened: true } });
    const repairing = turn({ type: "sync" }, [{ first: owner, second: viewer, revision: revision + 1 }]);
    expect(repairing.projection.views[service]).toMatchObject({ authorized: false, transitEndpoint: serviceEndpoint, canManage: false, reading: false, subscriptions: [], watchSubscriptions: [] });
    expect(repairing.projection.views[service]).not.toHaveProperty("transit");
    expect(JSON.parse(host.policy()).grants).toEqual([viewerUser]);
    for (const link of repairing.projection.baseLinks) for (const [sessionId, peer] of [[link.parent, link.child], [link.child, link.parent]]) turn({ type: "base_state", context: { ...context, sessionId }, peer, ready: true });
    serviceEndpoint = { sessionId: service, connectionId: crypto.randomUUID() };
    const replaced = turn({ type: "sync" });
    expect(replaced.projection.views[service]?.transitEndpoint).toEqual(serviceEndpoint);
    expect(replaced.projection.baseLinks.filter((link: { parent: string; child: string }) => link.parent === service || link.child === service).every((link: { ready: boolean }) => !link.ready)).toBe(true);
    serviceEndpoint = null;
    const unavailable = turn({ type: "sync" });
    expect(unavailable.projection.views[owner].allowServiceRelay).toBe(true);
    expect(unavailable.projection.views[service]).toBeUndefined();
    expect(turn(preference(false)).reply.result.type).toBe("done");
    expect(JSON.parse(host.policy()).allowServiceRelay).toBe(false);
    expect(JSON.parse(host.policy()).grants).toEqual([viewerUser]);
  } finally { host.free(); }
});

test("public Read does not retain pure site forwarding after the saved preference is Off", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  const [owner, viewer, service, binding] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const settings = { name: "Public", icon: "couch", access: "public", hidden: false };
  const policy = JSON.parse(rust.create_room_policy(JSON.stringify({ id: "public-transit", creatorId: owner, ...settings })));
  const host = new rust.RoomHost(JSON.stringify(policy));
  const endpoints = Object.fromEntries([owner, viewer, service].map(session => [session,
    { member: { userId: session }, connected: true, signingKey: Array(32).fill(0) }]));
  let revision = 0;
  const context = (sessionId: string) => ({ connection: sessionId, sessionId, requestId: crypto.randomUUID(), now: 100 });
  const turn = (action: object, failedPairs: object[] = []) => {
    host.dispatch(JSON.stringify({ now: 100, bindingId: binding, hostSessionId: owner, revision: ++revision,
      endpoints, serviceEndpoint: { sessionId: service, connectionId: service }, failedPairs, action }));
    return JSON.parse(host.finish());
  };
  const preference = (allowed: boolean) => ({ type: "command", context: context(owner),
    command: { type: "update_room", roomId: policy.id, ...settings, allowServiceRelay: allowed } });
  try {
    turn({ type: "sync" }); turn(preference(true));
    turn({ type: "command", context: context(viewer), command: { type: "voice", roomId: policy.id, joined: true, muted: true, deafened: true } });
    let current = turn({ type: "sync" }, [{ first: owner, second: viewer, revision: revision + 1 }]);
    expect(current.projection.baseLinks.some((link: { parent: string; child: string }) => link.parent === service || link.child === service)).toBe(true);
    for (const link of current.projection.baseLinks) for (const [sessionId, peer] of [[link.parent, link.child], [link.child, link.parent]]) {
      current = turn({ type: "base_state", context: context(sessionId), peer, ready: true });
    }
    const off = turn(preference(false));
    expect(off.projection.baseLinks.some((link: { parent: string; child: string }) => link.parent === service || link.child === service)).toBe(false);
    expect(off.projection.views[service]).toMatchObject({ authorized: true });
    expect(off.projection.views[service]).not.toHaveProperty("transitEndpoint");
    expect(off.projection.views[service]).not.toHaveProperty("transit");
    expect(JSON.parse(host.policy()).allowServiceRelay).toBe(false);
  } finally { host.free(); }
});
