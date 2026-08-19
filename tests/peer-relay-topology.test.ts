import { describe, expect, it } from "vitest";

import { PeerRelayTopology } from "../src/server/peer-relay-topology.ts";

function connected(...peerIds: string[]): Set<string> {
  return new Set(peerIds);
}

function expectValidTree(
  topology: PeerRelayTopology,
  roomId: string,
  hostPeerId: string,
  viewerPeerIds: readonly string[],
): number {
  const hostAssignment = topology.getAssignment(roomId, hostPeerId)!;
  expect(hostAssignment.parentPeerId).toBeNull();
  expect(hostAssignment.childPeerIds.length).toBeLessThanOrEqual(2);

  const allChildren = new Set(hostAssignment.childPeerIds);
  let maximumDepth = 0;
  for (const peerId of viewerPeerIds) {
    const assignment = topology.getAssignment(roomId, peerId)!;
    expect(assignment.childPeerIds.length).toBeLessThanOrEqual(1);
    for (const childPeerId of assignment.childPeerIds) {
      expect(allChildren.has(childPeerId)).toBe(false);
      allChildren.add(childPeerId);
    }

    let parentPeerId = assignment.parentPeerId;
    const ancestors = new Set([peerId]);
    let depth = 0;
    while (parentPeerId) {
      expect(ancestors.has(parentPeerId)).toBe(false);
      ancestors.add(parentPeerId);
      depth += 1;
      parentPeerId = topology.getAssignment(roomId, parentPeerId)?.parentPeerId ?? null;
    }
    maximumDepth = Math.max(maximumDepth, depth);
  }
  expect(allChildren).toEqual(new Set(viewerPeerIds));
  return maximumDepth;
}

describe("PeerRelayTopology", () => {
  it("fills the shallowest stable slots with bounded fanout", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    const host = "host";
    topology.setHost(roomId, host, connected(host));

    const viewers = ["viewer-a", "viewer-b", "viewer-c", "viewer-d", "viewer-e"];
    for (const viewer of viewers) {
      topology.addViewer(roomId, viewer, connected(host, ...viewers));
    }

    expect(topology.getAssignment(roomId, host)).toEqual({
      parentPeerId: null,
      childPeerIds: ["viewer-a", "viewer-b"],
    });
    expect(topology.getAssignment(roomId, "viewer-a")).toEqual({
      parentPeerId: host,
      childPeerIds: ["viewer-c"],
    });
    expect(topology.getAssignment(roomId, "viewer-b")).toEqual({
      parentPeerId: host,
      childPeerIds: ["viewer-d"],
    });
    expect(topology.getAssignment(roomId, "viewer-c")).toEqual({
      parentPeerId: "viewer-a",
      childPeerIds: ["viewer-e"],
    });
  });

  it("forms two bounded acyclic chains for eight viewers", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    const hostPeerId = "host";
    const viewerPeerIds = Array.from(
      { length: 8 },
      (_, index) => `viewer-${index + 1}`,
    );
    topology.setHost(roomId, hostPeerId, connected(hostPeerId));
    for (const peerId of viewerPeerIds) {
      topology.addViewer(
        roomId,
        peerId,
        connected(hostPeerId, ...viewerPeerIds),
      );
    }

    expect(expectValidTree(topology, roomId, hostPeerId, viewerPeerIds)).toBe(4);
  });

  it("leaves a disconnected viewer subtree sticky during its grace window", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    topology.setHost(roomId, "host", connected("host"));
    topology.addViewer(roomId, "viewer-a", connected("host", "viewer-a"));
    topology.addViewer(
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    topology.addViewer(
      roomId,
      "viewer-c",
      connected("host", "viewer-a", "viewer-b", "viewer-c"),
    );

    topology.addViewer(
      roomId,
      "viewer-d",
      connected("host", "viewer-b", "viewer-c", "viewer-d"),
    );

    expect(topology.getAssignment(roomId, "viewer-c")?.parentPeerId).toBe(
      "viewer-a",
    );
    expect(topology.getAssignment(roomId, "viewer-d")?.parentPeerId).toBe(
      "viewer-b",
    );
  });

  it("reattaches only the removed viewer's direct child subtree entry", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    topology.setHost(roomId, "host", connected("host"));
    topology.addViewer(roomId, "viewer-a", connected("host", "viewer-a"));
    topology.addViewer(
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    topology.addViewer(
      roomId,
      "viewer-c",
      connected("host", "viewer-a", "viewer-b", "viewer-c"),
    );
    topology.addViewer(
      roomId,
      "viewer-d",
      connected("host", "viewer-a", "viewer-b", "viewer-c", "viewer-d"),
    );
    topology.addViewer(
      roomId,
      "viewer-e",
      connected(
        "host",
        "viewer-a",
        "viewer-b",
        "viewer-c",
        "viewer-d",
        "viewer-e",
      ),
    );

    const changes = topology.removeViewer(
      roomId,
      "viewer-a",
      connected("host", "viewer-b", "viewer-c", "viewer-d", "viewer-e"),
    );

    expect(topology.getAssignment(roomId, "host")?.childPeerIds).toEqual([
      "viewer-b",
      "viewer-c",
    ]);
    expect(topology.getAssignment(roomId, "viewer-c")?.parentPeerId).toBe(
      "host",
    );
    expect(topology.getAssignment(roomId, "viewer-e")?.parentPeerId).toBe(
      "viewer-c",
    );
    expect(changes.map((change) => change.peerId).sort()).toEqual([
      "host",
      "viewer-c",
    ]);
  });

  it("waits to reattach an offline subtree root until it reconnects", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    topology.setHost(roomId, "host", connected("host"));
    topology.addViewer(roomId, "viewer-a", connected("host", "viewer-a"));
    topology.addViewer(
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    topology.addViewer(
      roomId,
      "viewer-c",
      connected("host", "viewer-a", "viewer-b", "viewer-c"),
    );

    topology.removeViewer(
      roomId,
      "viewer-a",
      connected("host", "viewer-b"),
    );

    expect(topology.getAssignment(roomId, "viewer-c")?.parentPeerId).toBeNull();
    expect(topology.getAssignment(roomId, "host")?.childPeerIds).toEqual([
      "viewer-b",
    ]);

    const reconnectChanges = topology.addViewer(
      roomId,
      "viewer-c",
      connected("host", "viewer-b", "viewer-c"),
    );

    expect(topology.getAssignment(roomId, "viewer-c")?.parentPeerId).toBe(
      "host",
    );
    expect(reconnectChanges.map((change) => change.peerId).sort()).toEqual([
      "host",
      "viewer-c",
    ]);
  });

  it("assigns connected pending viewers when removals make slots reachable", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    topology.setHost(roomId, "host", connected("host"));
    for (const peerId of ["a", "b", "c", "d"]) {
      topology.addViewer(
        roomId,
        peerId,
        connected("host", "a", "b", "c", "d"),
      );
    }

    topology.addViewer(roomId, "e", connected("host", "c", "d", "e"));
    expect(topology.getAssignment(roomId, "e")?.parentPeerId).toBeNull();

    topology.removeViewer(roomId, "a", connected("host", "c", "d", "e"));
    topology.removeViewer(roomId, "b", connected("host", "c", "d", "e"));

    expect(topology.getAssignment(roomId, "e")?.parentPeerId).toBe("c");
    expect(topology.getAssignment(roomId, "c")?.childPeerIds).toEqual(["e"]);
  });

  it("keeps pending viewers unassigned until a host arrives", () => {
    const topology = new PeerRelayTopology();
    topology.addViewer("room", "viewer-a", connected("viewer-a"));
    expect(topology.getAssignment("room", "viewer-a")?.parentPeerId).toBeNull();

    topology.setHost(
      "room",
      "host",
      connected("host", "viewer-a"),
    );
    expect(topology.getAssignment("room", "viewer-a")?.parentPeerId).toBe(
      "host",
    );
  });

  it("updates only direct root parents when the host identity changes", () => {
    const topology = new PeerRelayTopology();
    topology.setHost("room", "host-a", connected("host-a"));
    topology.addViewer(
      "room",
      "viewer-a",
      connected("host-a", "viewer-a"),
    );
    topology.addViewer(
      "room",
      "viewer-b",
      connected("host-a", "viewer-a", "viewer-b"),
    );
    topology.addViewer(
      "room",
      "viewer-c",
      connected("host-a", "viewer-a", "viewer-b", "viewer-c"),
    );

    topology.setHost(
      "room",
      "host-b",
      connected("host-b", "viewer-a", "viewer-b", "viewer-c"),
    );

    expect(topology.getAssignment("room", "viewer-a")?.parentPeerId).toBe(
      "host-b",
    );
    expect(topology.getAssignment("room", "viewer-b")?.parentPeerId).toBe(
      "host-b",
    );
    expect(topology.getAssignment("room", "viewer-c")?.parentPeerId).toBe(
      "viewer-a",
    );
  });

  it("drops all assignments when a room is deleted", () => {
    const topology = new PeerRelayTopology();
    topology.setHost("room", "host-a", connected("host-a"));
    topology.addViewer(
      "room",
      "viewer-a",
      connected("host-a", "viewer-a"),
    );

    topology.deleteRoom("room");
    expect(topology.getAssignment("room", "host-a")).toBeUndefined();
    expect(topology.getAssignment("room", "viewer-a")).toBeUndefined();

    topology.setHost("room", "host-b", connected("host-b"));
    expect(topology.getAssignment("room", "host-b")).toEqual({
      parentPeerId: null,
      childPeerIds: [],
    });
  });
});
