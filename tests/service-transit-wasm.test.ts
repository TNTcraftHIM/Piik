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
  let confirmedPairs: string[][] = [];
  const turn = (action: object, failedPairs: object[] = [], commit = true) => {
    const work = JSON.parse(host.dispatch(JSON.stringify({ now: 100, bindingId: binding, channelOwnerId: ownerUser, hostSessionId: owner, revision: ++revision, endpoints, confirmedPairs, serviceEndpoint, failedPairs, action })));
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
    for (const sessionId of [owner, viewer]) turn({ type: "command", context: { ...context, sessionId },
      command: { type: "voice", roomId: policy.id, joined: true, muted: false, deafened: false } });
    const publicationId = crypto.randomUUID();
    turn({ type: "command", context, command: { type: "publish", publication: { id: publicationId, roomId: policy.id, kind: "voice" } } });
    const failedPairs = [{ first: owner, second: viewer, revision: revision + 1 }];
    expect(turn({ type: "sync" }, failedPairs).projection.flows).toEqual([]);
    confirmedPairs = [[owner, service].sort(), [service, viewer].sort()];
    const repairing = turn({ type: "sync" }, failedPairs);
    expect(repairing.projection.views[service]).toMatchObject({ authorized: false, transitEndpoint: serviceEndpoint, canManage: false, reading: false, subscriptions: [], watchSubscriptions: [] });
    expect(repairing.projection.views[service]).not.toHaveProperty("transit");
    expect(JSON.parse(host.policy()).grants).toEqual([viewerUser]);
    expect(repairing.projection.flows).toContainEqual(expect.objectContaining({ sender: owner, receiver: service }));
    serviceEndpoint = { sessionId: service, connectionId: crypto.randomUUID() };
    confirmedPairs = [];
    const replaced = turn({ type: "sync" }, failedPairs);
    expect(replaced.projection.views[service]).toBeUndefined();
    expect(replaced.projection.flows).toEqual([]);
    serviceEndpoint = null;
    const unavailable = turn({ type: "sync" });
    expect(unavailable.projection.allowServiceRelay).toBe(true);
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
  let confirmedPairs: string[][] = [];
  const turn = (action: object, failedPairs: object[] = []) => {
    host.dispatch(JSON.stringify({ now: 100, bindingId: binding, channelOwnerId: owner, hostSessionId: owner, revision: ++revision,
      endpoints, confirmedPairs, serviceEndpoint: { sessionId: service, connectionId: service }, failedPairs, action }));
    return JSON.parse(host.finish());
  };
  const preference = (allowed: boolean) => ({ type: "command", context: context(owner),
    command: { type: "update_room", roomId: policy.id, ...settings, allowServiceRelay: allowed } });
  try {
    turn({ type: "sync" }); turn(preference(true));
    for (const sessionId of [owner, viewer]) turn({ type: "command", context: context(sessionId),
      command: { type: "voice", roomId: policy.id, joined: true, muted: false, deafened: false } });
    turn({ type: "command", context: context(owner), command: { type: "publish",
      publication: { id: crypto.randomUUID(), roomId: policy.id, kind: "voice" } } });
    confirmedPairs = [[owner, service].sort(), [service, viewer].sort()];
    const current = turn({ type: "sync" }, [{ first: owner, second: viewer, revision: revision + 1 }]);
    expect(current.projection.views[service].transitEndpoint.sessionId).toBe(service);
    const off = turn(preference(false));
    expect(off.projection.flows).toEqual([]);
    expect(off.projection.views[service]).toMatchObject({ authorized: true });
    expect(off.projection.views[service]).not.toHaveProperty("transitEndpoint");
    expect(off.projection.views[service]).not.toHaveProperty("transit");
    expect(JSON.parse(host.policy()).allowServiceRelay).toBe(false);
  } finally { host.free(); }
});
