import { describe, expect, it } from "vitest";

import { PeerRelayTopology } from "../src/server/peer-relay-topology.ts";

function connected(...peerIds: string[]): Set<string> {
  return new Set(peerIds);
}

function addRelayViewer(
  topology: PeerRelayTopology,
  roomId: string,
  peerId: string,
  connectedPeerIds: ReadonlySet<string>,
  downstreamEdges: 1 | 2 = 1,
) {
  const changes = topology.addViewer(roomId, peerId, connectedPeerIds);
  return [
    ...changes,
    ...topology.setViewerRelayCapacity(
      roomId,
      peerId,
      downstreamEdges,
      connectedPeerIds,
    ),
  ];
}

function expectValidTree(
  topology: PeerRelayTopology,
  roomId: string,
  hostPeerId: string,
  viewerPeerIds: readonly string[],
  maxViewerChildren = 1,
): number {
  const hostAssignment = topology.getAssignment(roomId, hostPeerId)!;
  expect(hostAssignment.parentPeerId).toBeNull();
  expect(hostAssignment.childPeerIds.length).toBeLessThanOrEqual(2);

  const allChildren = new Set(hostAssignment.childPeerIds);
  let maximumDepth = 0;
  for (const peerId of viewerPeerIds) {
    const assignment = topology.getAssignment(roomId, peerId)!;
    expect(assignment.childPeerIds.length).toBeLessThanOrEqual(
      maxViewerChildren,
    );
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
  it("keeps viewers as leaves until a relay slot is explicitly advertised", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "viewer-a", "viewer-b", "viewer-c");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "viewer-a", peers);
    topology.addViewer("room", "viewer-b", peers);
    topology.addViewer("room", "viewer-c", peers);

    expect(topology.getAssignment("room", "viewer-c")?.parentPeerId).toBeNull();
    expect(
      topology.setViewerRelayCapacity("room", "viewer-a", 0, peers),
    ).toEqual([]);

    const changes = topology.setViewerRelayCapacity(
      "room",
      "viewer-a",
      1,
      peers,
    );
    expect(changes.map(({ peerId }) => peerId).sort()).toEqual([
      "viewer-a",
      "viewer-c",
    ]);
    expect(topology.getAssignment("room", "viewer-a")).toEqual({
      parentPeerId: "host",
      childPeerIds: ["viewer-c"],
    });
    expect(topology.getAssignment("room", "viewer-b")?.parentPeerId).toBe(
      "host",
    );
  });

  it("deterministically promotes an unassigned relay over the oldest zero-capacity host leaf", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "viewer-a", "viewer-b", "viewer-c");
    topology.setHost("room", "host", peers);
    for (const peerId of ["viewer-a", "viewer-b", "viewer-c"]) {
      topology.addViewer("room", peerId, peers);
    }

    const changes = topology.setViewerRelayCapacity(
      "room",
      "viewer-c",
      1,
      peers,
      { rescueUnassignedRelay: true },
    );

    expect(changes.map(({ peerId }) => peerId)).toEqual([
      "host",
      "viewer-a",
      "viewer-c",
    ]);
    expect(topology.getAssignment("room", "host")).toEqual({
      parentPeerId: null,
      childPeerIds: ["viewer-b", "viewer-c"],
    });
    expect(topology.getAssignment("room", "viewer-c")).toEqual({
      parentPeerId: "host",
      childPeerIds: ["viewer-a"],
    });
    expect(topology.getAssignment("room", "viewer-a")).toEqual({
      parentPeerId: "viewer-c",
      childPeerIds: [],
    });
    expect(
      expectValidTree(
        topology,
        "room",
        "host",
        ["viewer-a", "viewer-b", "viewer-c"],
      ),
    ).toBe(2);

    const afterRescue = topology.getAssignments("room");
    topology.setViewerRelayCapacity("room", "viewer-c", 0, peers);
    expect(
      topology.setViewerRelayCapacity(
        "room",
        "viewer-c",
        1,
        peers,
        { rescueUnassignedRelay: true },
      ),
    ).toEqual([]);
    expect(topology.getAssignments("room")).toEqual(afterRescue);
  });

  it("does not rescue admission through a host child that already owns a subtree", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "a", "b", "c", "d", "candidate");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "a", peers);
    topology.addViewer("room", "b", peers);
    topology.setViewerRelayCapacity("room", "a", 1, peers);
    topology.setViewerRelayCapacity("room", "b", 1, peers);
    topology.addViewer("room", "c", peers);
    topology.addViewer("room", "d", peers);
    topology.addViewer("room", "candidate", peers);
    const before = topology.getAssignments("room");

    expect(
      topology.setViewerRelayCapacity(
        "room",
        "candidate",
        1,
        peers,
        { rescueUnassignedRelay: true },
      ),
    ).toEqual([]);
    expect(topology.getAssignments("room")).toEqual(before);
  });

  it("does not migrate healthy edges when a relay withdraws capacity", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "viewer-a", "viewer-b", "viewer-c", "viewer-d");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "viewer-a", peers);
    topology.addViewer("room", "viewer-b", peers);
    topology.setViewerRelayCapacity("room", "viewer-a", 1, peers);
    topology.addViewer("room", "viewer-c", peers);

    expect(
      topology.setViewerRelayCapacity("room", "viewer-a", 0, peers),
    ).toEqual([]);
    topology.addViewer("room", "viewer-d", peers);

    expect(topology.getAssignment("room", "viewer-c")?.parentPeerId).toBe(
      "viewer-a",
    );
    expect(topology.getAssignment("room", "viewer-d")?.parentPeerId).toBeNull();
  });

  it("keeps server relay ineligibility separate from advertised capacity", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "relay", "sibling", "child", "pending");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "relay", peers);
    topology.addViewer("room", "sibling", peers);
    topology.setViewerRelayCapacity("room", "relay", 1, peers);
    topology.addViewer("room", "child", peers);

    topology.setViewerRelayEligible("room", "relay", false);
    expect(topology.getDownstreamCapacity("room", "relay")).toBe(0);
    expect(topology.getAdvertisedDownstreamCapacity("room", "relay")).toBe(1);
    expect(topology.getAssignment("room", "child")?.parentPeerId).toBe("relay");
    expect(
      topology.setViewerRelayCapacity("room", "relay", 2, peers),
    ).toEqual([]);
    expect(topology.getAdvertisedDownstreamCapacity("room", "relay")).toBe(2);
    topology.addViewer("room", "pending", peers);
    expect(topology.getAssignment("room", "pending")?.parentPeerId).toBeNull();

    topology.setViewerRelayEligible("room", "relay", true);
    topology.setViewerRelayCapacity("room", "relay", 2, peers);
    expect(topology.getAssignment("room", "pending")?.parentPeerId).toBe(
      "relay",
    );
    topology.setViewerRelayEligible("room", "host", false);
    expect(topology.getDownstreamCapacity("room", "host")).toBe(2);
  });

  it("clamps advertisements to the deployment limit and can opt into three", () => {
    const peers = connected("host", "relay");
    const defaultTopology = new PeerRelayTopology();
    defaultTopology.setHost("default", "host", peers);
    defaultTopology.addViewer("default", "relay", peers);
    defaultTopology.setViewerRelayCapacity("default", "relay", 3, peers);
    expect(
      defaultTopology.getAdvertisedDownstreamCapacity("default", "host"),
    ).toBe(2);
    expect(
      defaultTopology.getAdvertisedDownstreamCapacity("default", "relay"),
    ).toBe(2);

    const expandedTopology = new PeerRelayTopology(3);
    expandedTopology.setHost("expanded", "host", peers);
    expandedTopology.addViewer("expanded", "relay", peers);
    expandedTopology.setViewerRelayCapacity("expanded", "relay", 3, peers);
    expect(
      expandedTopology.getAdvertisedDownstreamCapacity("expanded", "host"),
    ).toBe(3);
    expect(
      expandedTopology.getAdvertisedDownstreamCapacity("expanded", "relay"),
    ).toBe(3);
  });

  it("does not reassign a failed edge through a viewer leaf", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "viewer-a", "viewer-b", "viewer-c");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "viewer-a", peers);
    topology.addViewer("room", "viewer-b", peers);
    topology.setViewerRelayCapacity("room", "viewer-a", 1, peers);
    topology.addViewer("room", "viewer-c", peers);

    expect(
      topology.reassignViewer(
        "room",
        "viewer-c",
        peers,
        new Set(["viewer-a"]),
      ),
    ).toBeUndefined();
    expect(topology.getAssignment("room", "viewer-c")?.parentPeerId).toBe(
      "viewer-a",
    );
  });

  it("requires a reconnecting viewer to advertise capacity again", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "viewer-a", "viewer-b", "viewer-c", "viewer-d");
    topology.setHost("room", "host", peers);
    topology.addViewer("room", "viewer-a", peers);
    topology.addViewer("room", "viewer-b", peers);
    topology.setViewerRelayCapacity("room", "viewer-a", 1, peers);
    topology.addViewer("room", "viewer-c", peers);

    topology.addViewer("room", "viewer-a", peers);
    topology.addViewer("room", "viewer-d", peers);

    expect(topology.getAssignment("room", "viewer-c")?.parentPeerId).toBe(
      "viewer-a",
    );
    expect(topology.getAssignment("room", "viewer-d")?.parentPeerId).toBeNull();
  });

  it("fills the shallowest stable slots with bounded fanout", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    const host = "host";
    topology.setHost(roomId, host, connected(host));

    const viewers = ["viewer-a", "viewer-b", "viewer-c", "viewer-d", "viewer-e"];
    for (const viewer of viewers) {
      addRelayViewer(topology, roomId, viewer, connected(host, ...viewers));
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
      addRelayViewer(
        topology,
        roomId,
        peerId,
        connected(hostPeerId, ...viewerPeerIds),
      );
    }

    expect(expectValidTree(topology, roomId, hostPeerId, viewerPeerIds)).toBe(4);
  });

  it("forms a bounded depth-three DAG for eight capacity-two viewers", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    const hostPeerId = "host";
    const viewerPeerIds = Array.from(
      { length: 8 },
      (_, index) => `viewer-${index + 1}`,
    );
    const peers = connected(hostPeerId, ...viewerPeerIds);
    topology.setHost(roomId, hostPeerId, peers);

    for (let index = 0; index < viewerPeerIds.length; index += 1) {
      addRelayViewer(
        topology,
        roomId,
        viewerPeerIds[index]!,
        peers,
        2,
      );
      expectValidTree(
        topology,
        roomId,
        hostPeerId,
        viewerPeerIds.slice(0, index + 1),
        2,
      );
    }

    expect(topology.getAssignment(roomId, "viewer-1")?.childPeerIds).toEqual([
      "viewer-3",
      "viewer-4",
    ]);
    expect(topology.getDownstreamCapacity(roomId, "viewer-1")).toBe(2);
    expect(topology.getAssignment(roomId, "viewer-5")?.parentPeerId).toBe(
      "viewer-2",
    );
    expect(
      expectValidTree(topology, roomId, hostPeerId, viewerPeerIds, 2),
    ).toBe(3);
  });

  it("reattaches both child subtrees when a capacity-two relay leaves", () => {
    const topology = new PeerRelayTopology();
    const peers = connected("host", "relay", "sibling", "child-a", "child-b");
    topology.setHost("room", "host", peers);
    addRelayViewer(topology, "room", "relay", peers, 2);
    addRelayViewer(topology, "room", "sibling", peers, 2);
    addRelayViewer(topology, "room", "child-a", peers, 2);
    addRelayViewer(topology, "room", "child-b", peers, 2);
    expect(topology.getAssignment("room", "relay")?.childPeerIds).toEqual([
      "child-a",
      "child-b",
    ]);

    topology.removeViewer(
      "room",
      "relay",
      connected("host", "sibling", "child-a", "child-b"),
    );

    expect(topology.getAssignment("room", "child-a")?.parentPeerId).toBe(
      "host",
    );
    expect(topology.getAssignment("room", "child-b")?.parentPeerId).toBe(
      "sibling",
    );
    expect(
      expectValidTree(
        topology,
        "room",
        "host",
        ["sibling", "child-a", "child-b"],
        2,
      ),
    ).toBe(2);
  });

  it("uses the same depth-four bound for initial admission", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    const peerIds = [
      "host",
      "viewer-a",
      "viewer-b",
      "viewer-c",
      "viewer-d",
      "viewer-e",
      "viewer-f",
    ];
    const peers = connected(...peerIds);
    topology.setHost(roomId, "host", peers);
    topology.addViewer(roomId, "viewer-a", peers);
    topology.setViewerRelayCapacity(roomId, "viewer-a", 1, peers);
    topology.addViewer(roomId, "viewer-b", peers);
    for (const peerId of ["viewer-c", "viewer-d", "viewer-e"]) {
      topology.addViewer(roomId, peerId, peers);
      topology.setViewerRelayCapacity(roomId, peerId, 1, peers);
    }
    topology.addViewer(roomId, "viewer-f", peers);

    expect(topology.getAssignment(roomId, "viewer-e")?.parentPeerId).toBe(
      "viewer-d",
    );
    expect(topology.getAssignment(roomId, "viewer-f")?.parentPeerId).toBeNull();
    expect(
      expectValidTree(
        topology,
        roomId,
        "host",
        peerIds.slice(1, -1),
      ),
    ).toBe(4);
  });

  it("leaves a disconnected viewer subtree sticky during its grace window", () => {
    const topology = new PeerRelayTopology();
    const roomId = "room";
    topology.setHost(roomId, "host", connected("host"));
    addRelayViewer(topology, roomId, "viewer-a", connected("host", "viewer-a"));
    addRelayViewer(
      topology,
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    addRelayViewer(
      topology,
      roomId,
      "viewer-c",
      connected("host", "viewer-a", "viewer-b", "viewer-c"),
    );

    addRelayViewer(
      topology,
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
    addRelayViewer(topology, roomId, "viewer-a", connected("host", "viewer-a"));
    addRelayViewer(
      topology,
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    addRelayViewer(
      topology,
      roomId,
      "viewer-c",
      connected("host", "viewer-a", "viewer-b", "viewer-c"),
    );
    addRelayViewer(
      topology,
      roomId,
      "viewer-d",
      connected("host", "viewer-a", "viewer-b", "viewer-c", "viewer-d"),
    );
    addRelayViewer(
      topology,
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
    addRelayViewer(topology, roomId, "viewer-a", connected("host", "viewer-a"));
    addRelayViewer(
      topology,
      roomId,
      "viewer-b",
      connected("host", "viewer-a", "viewer-b"),
    );
    addRelayViewer(
      topology,
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

    const reconnectChanges = addRelayViewer(
      topology,
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
      addRelayViewer(
        topology,
        roomId,
        peerId,
        connected("host", "a", "b", "c", "d"),
      );
    }

    addRelayViewer(topology, roomId, "e", connected("host", "c", "d", "e"));
    expect(topology.getAssignment(roomId, "e")?.parentPeerId).toBeNull();

    topology.removeViewer(roomId, "a", connected("host", "c", "d", "e"));
    topology.removeViewer(roomId, "b", connected("host", "c", "d", "e"));

    expect(topology.getAssignment(roomId, "e")?.parentPeerId).toBe("c");
    expect(topology.getAssignment(roomId, "c")?.childPeerIds).toEqual(["e"]);
  });

  it("keeps pending viewers unassigned until a host arrives", () => {
    const topology = new PeerRelayTopology();
    addRelayViewer(topology, "room", "viewer-a", connected("viewer-a"));
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
    addRelayViewer(
      topology,
      "room",
      "viewer-a",
      connected("host-a", "viewer-a"),
    );
    addRelayViewer(
      topology,
      "room",
      "viewer-b",
      connected("host-a", "viewer-a", "viewer-b"),
    );
    addRelayViewer(
      topology,
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

  it("reassigns a failed edge deterministically without entering its subtree", () => {
    const topology = new PeerRelayTopology();
    const peers = ["host", "a", "b", "c", "d", "e"];
    topology.setHost("room", "host", connected(...peers));
    for (const peerId of peers.slice(1)) {
      addRelayViewer(topology, "room", peerId, connected(...peers));
    }

    expect(topology.getAssignment("room", "e")?.parentPeerId).toBe("c");
    const changes = topology.reassignViewer(
      "room",
      "e",
      connected(...peers),
      new Set(["c"]),
      4,
    );

    expect(changes?.map(({ peerId }) => peerId).sort()).toEqual([
      "c",
      "d",
      "e",
    ]);
    expect(topology.getAssignment("room", "e")?.parentPeerId).toBe("d");
    expect(expectValidTree(topology, "room", "host", peers.slice(1))).toBe(3);
  });

  it("does not mutate when every bounded reparent candidate is excluded", () => {
    const topology = new PeerRelayTopology();
    topology.setHost("room", "host", connected("host", "a", "b", "c"));
    for (const peerId of ["a", "b", "c"]) {
      addRelayViewer(
        topology,
        "room",
        peerId,
        connected("host", "a", "b", "c"),
      );
    }
    const before = topology.getAssignments("room");

    expect(
      topology.reassignViewer(
        "room",
        "c",
        connected("host", "a", "b", "c"),
        new Set(["host", "a", "b"]),
        4,
      ),
    ).toBeUndefined();
    expect(topology.getAssignments("room")).toEqual(before);
  });

  it("rejects a reparent whose deepest descendant would exceed max depth", () => {
    const topology = new PeerRelayTopology();
    const peers = ["host", "a", "b", "c", "d", "e", "f", "g", "h"];
    topology.setHost("room", "host", connected(...peers));
    for (const peerId of peers.slice(1)) {
      addRelayViewer(topology, "room", peerId, connected(...peers));
    }
    const before = topology.getAssignments("room");

    expect(topology.getAssignment("room", "g")?.parentPeerId).toBe("e");
    expect(
      topology.reassignViewer(
        "room",
        "g",
        connected(...peers),
        new Set(["e"]),
        4,
      ),
    ).toBeUndefined();
    expect(topology.getAssignments("room")).toEqual(before);
  });

  it("does not attach a pending subtree beyond the initial-admission depth bound", () => {
    const topology = new PeerRelayTopology();
    const initialPeers = ["host", "a", "b", "c", "d", "e", "f", "g", "h"];
    topology.setHost("room", "host", connected(...initialPeers));
    for (const peerId of initialPeers.slice(1)) {
      addRelayViewer(topology, "room", peerId, connected(...initialPeers));
    }
    expect(topology.getAssignment("room", "e")).toMatchObject({
      parentPeerId: "c",
      childPeerIds: ["g"],
    });

    topology.removeViewer(
      "room",
      "c",
      connected("host", "a", "b", "d", "f", "h"),
    );
    topology.removeViewer(
      "room",
      "h",
      connected("host", "a", "b", "d", "f"),
    );
    topology.addViewer(
      "room",
      "x",
      connected("host", "a", "b", "d", "f", "x"),
    );

    topology.addViewer(
      "room",
      "e",
      connected("host", "a", "b", "d", "e", "f", "g", "x"),
    );

    expect(topology.getAssignment("room", "e")?.parentPeerId).toBeNull();
    expect(topology.getAssignment("room", "g")?.parentPeerId).toBe("e");
    expect(topology.getAssignment("room", "f")?.childPeerIds).toEqual([]);
  });

  it("drops all assignments when a room is deleted", () => {
    const topology = new PeerRelayTopology();
    topology.setHost("room", "host-a", connected("host-a"));
    addRelayViewer(
      topology,
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
