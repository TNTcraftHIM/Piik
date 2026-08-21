import { describe, expect, it } from "vitest";

import {
  MediaRouteController,
  type PrepareMediaRouteInput,
} from "../src/server/media-route-controller.ts";
import type { ParticipantRouteAssignment } from "../src/shared/protocol.ts";

const HOST = "host_12345678";
const DIRECT_ROOT = "viewer_direct_12345678";
const SFU_ROOT_A = "viewer_sfu_a_12345678";
const SFU_ROOT_B = "viewer_sfu_b_12345678";
const THIRD_CHILD = "viewer_third_12345678";
const SFU_ROOT_C = "viewer_sfu_c_12345678";
const GENERATION_A = "generation_a_12345678";
const GENERATION_B = "generation_b_12345678";

function assignment(
  upstream: ParticipantRouteAssignment["upstream"],
  childPeerIds: string[] = [],
  sfuPublicationGeneration: string | null = null,
): ParticipantRouteAssignment {
  return { upstream, childPeerIds, sfuPublicationGeneration };
}

function directAssignments(): Map<string, ParticipantRouteAssignment> {
  return new Map([
    [HOST, assignment({ kind: "none" }, [DIRECT_ROOT, SFU_ROOT_A])],
    [DIRECT_ROOT, assignment({ kind: "peer", peerId: HOST })],
    [SFU_ROOT_A, assignment({ kind: "peer", peerId: HOST })],
    [SFU_ROOT_B, assignment({ kind: "none" })],
  ]);
}

function hybridPlan(
  generation = GENERATION_A,
  rootPeerId = SFU_ROOT_A,
): PrepareMediaRouteInput {
  const otherRootPeerId =
    rootPeerId === SFU_ROOT_A ? SFU_ROOT_B : SFU_ROOT_A;
  return {
    assignments: new Map([
      [
        HOST,
        assignment({ kind: "none" }, [DIRECT_ROOT], generation),
      ],
      [DIRECT_ROOT, assignment({ kind: "peer", peerId: HOST })],
      [rootPeerId, assignment({ kind: "sfu" })],
      [otherRootPeerId, assignment({ kind: "none" })],
    ]),
    expectedParticipantIds: new Set([HOST, rootPeerId]),
    sfuPublicationGeneration: generation,
    sfuRootPeerIds: [rootPeerId],
  };
}

function controller(
  assignments = directAssignments(),
): MediaRouteController {
  return new MediaRouteController({ hostPeerId: HOST, assignments });
}

function chainedAssignments(): Map<string, ParticipantRouteAssignment> {
  return new Map([
    [HOST, assignment({ kind: "none" }, [DIRECT_ROOT])],
    [
      DIRECT_ROOT,
      assignment({ kind: "peer", peerId: HOST }, [SFU_ROOT_A]),
    ],
    [SFU_ROOT_A, assignment({ kind: "peer", peerId: DIRECT_ROOT })],
    [SFU_ROOT_B, assignment({ kind: "none" })],
  ]);
}

describe("MediaRouteController", () => {
  it("SFU root invariant gate: accepts two roots, rejects a third, and charges one Host publication edge", () => {
    const assignments = new Map<string, ParticipantRouteAssignment>([
      [
        HOST,
        assignment({ kind: "none" }, [DIRECT_ROOT], GENERATION_A),
      ],
      [DIRECT_ROOT, assignment({ kind: "peer", peerId: HOST })],
      [SFU_ROOT_A, assignment({ kind: "sfu" })],
      [SFU_ROOT_B, assignment({ kind: "sfu" })],
    ]);
    const routes = new MediaRouteController({
      hostPeerId: HOST,
      assignments,
      sfuPublicationGeneration: GENERATION_A,
      sfuRootPeerIds: [SFU_ROOT_A, SFU_ROOT_B],
    });

    expect(routes.getActiveRoute().sfu.rootPeerIds).toEqual([
      SFU_ROOT_A,
      SFU_ROOT_B,
    ]);
    expect(routes.hostActiveMediaEdges()).toBe(2);

    const excessiveRoots = new Map(assignments);
    excessiveRoots.set(SFU_ROOT_C, assignment({ kind: "sfu" }));
    expect(
      () =>
        new MediaRouteController({
          hostPeerId: HOST,
          assignments: excessiveRoots,
          sfuPublicationGeneration: GENERATION_A,
          sfuRootPeerIds: [SFU_ROOT_A, SFU_ROOT_B, SFU_ROOT_C],
        }),
    ).toThrow("SFU root participants must be unique and bounded");

    const excessiveHostEdges = new Map(assignments);
    excessiveHostEdges.set(
      HOST,
      assignment(
        { kind: "none" },
        [DIRECT_ROOT, SFU_ROOT_C],
        GENERATION_A,
      ),
    );
    excessiveHostEdges.set(
      SFU_ROOT_C,
      assignment({ kind: "peer", peerId: HOST }),
    );
    expect(
      () =>
        new MediaRouteController({
          hostPeerId: HOST,
          assignments: excessiveHostEdges,
          sfuPublicationGeneration: GENERATION_A,
          sfuRootPeerIds: [SFU_ROOT_A, SFU_ROOT_B],
        }),
    ).toThrow("Host active media edge budget exceeded");
  });

  it("atomically commits only after every expected participant is ready", () => {
    const routes = controller();
    const revision = routes.prepare(hybridPlan())!;

    expect(revision).toBe(1);
    expect(routes.getActiveRoute().sfu.publicationGeneration).toBeNull();
    expect(routes.ready(HOST, revision, "prepare")).toBe(true);
    expect(routes.ready(HOST, revision, "prepare")).toBe(false);
    expect(routes.commit(revision)).toBe(false);
    expect(routes.getActiveRoute().revision).toBe(0);

    expect(routes.ready(SFU_ROOT_A, revision, "prepare")).toBe(true);
    expect(routes.getActiveRoute().sfu.publicationGeneration).toBeNull();
    expect(routes.commit(revision)).toBe(true);
    expect(routes.getPendingRoute()).toBeUndefined();
    expect(routes.getActiveRoute()).toMatchObject({
      revision,
      sfu: {
        publicationGeneration: GENERATION_A,
        rootPeerIds: [SFU_ROOT_A],
      },
    });
    expect(routes.hostActiveMediaEdges()).toBe(2);
  });

  it("allows only one pending plan and ignores stale or wrong-phase messages", () => {
    const routes = controller();
    const revision = routes.prepare(hybridPlan())!;

    expect(routes.prepare(hybridPlan(GENERATION_B, SFU_ROOT_B))).toBeUndefined();
    expect(routes.ready(HOST, revision - 1, "prepare")).toBe(false);
    expect(routes.ready(HOST, revision, "active")).toBe(false);
    expect(routes.commit(revision - 1)).toBe(false);
    expect(routes.abort(revision - 1)).toBe(false);
    expect(routes.getPendingRoute()?.route.revision).toBe(revision);
    expect(routes.getActiveRoute().revision).toBe(0);
  });

  it("aborts to the unchanged active topology with a newer revision", () => {
    const routes = controller();
    const before = routes.getActiveRoute();
    const preparedRevision = routes.prepare(hybridPlan())!;

    expect(routes.abort(preparedRevision)).toBe(true);
    const after = routes.getActiveRoute();
    expect(after.revision).toBe(preparedRevision + 1);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.sfu).toEqual(before.sfu);
    expect(routes.getPendingRoute()).toBeUndefined();
    expect(routes.abort(preparedRevision)).toBe(false);

    expect(routes.prepare(hybridPlan())).toBe(after.revision + 1);
  });

  it("reconciles complete baseline snapshots without resetting revisions", () => {
    const routes = controller();
    const reconciledRevision = routes.reconcileBaseline({
      assignments: chainedAssignments(),
    });

    expect(reconciledRevision).toBe(1);
    expect(routes.getActiveRoute().revision).toBe(1);
    expect(
      routes.getActiveRoute().assignments.get(SFU_ROOT_A)?.upstream,
    ).toEqual({ kind: "peer", peerId: DIRECT_ROOT });
    expect(
      routes.reconcileBaseline({ assignments: chainedAssignments() }),
    ).toBeUndefined();
    expect(routes.getActiveRoute().revision).toBe(1);

    const preparedRevision = routes.prepare(hybridPlan())!;
    expect(
      routes.reconcileBaseline({ assignments: directAssignments() }),
    ).toBeUndefined();
    expect(routes.getActiveRoute().revision).toBe(1);
    expect(routes.abort(preparedRevision)).toBe(true);
    expect(routes.getActiveRoute().revision).toBe(3);

    expect(
      routes.reconcileBaseline({ assignments: directAssignments() }),
    ).toBe(4);
    expect(routes.getActiveRoute().revision).toBe(4);
    expect(routes.hostActiveMediaEdges()).toBe(2);
  });

  it("preserves active SFU state while reconciling peer topology", () => {
    const activePlan = hybridPlan(GENERATION_A, SFU_ROOT_A);
    const routes = new MediaRouteController({
      hostPeerId: HOST,
      assignments: activePlan.assignments,
      revision: 6,
      sfuPublicationGeneration: GENERATION_A,
      sfuRootPeerIds: [SFU_ROOT_A],
    });
    const assignments = new Map(activePlan.assignments);
    assignments.set(
      DIRECT_ROOT,
      assignment({ kind: "peer", peerId: HOST }, [SFU_ROOT_B]),
    );
    assignments.set(
      SFU_ROOT_B,
      assignment({ kind: "peer", peerId: DIRECT_ROOT }),
    );

    expect(routes.reconcileBaseline({ assignments })).toBe(7);
    expect(routes.getActiveRoute().sfu).toEqual({
      publicationGeneration: GENERATION_A,
      rootPeerIds: [SFU_ROOT_A],
    });
    expect(routes.hostActiveMediaEdges()).toBe(2);
  });

  it("never overlaps old and new SFU publication generations", () => {
    const initialPlan = hybridPlan(GENERATION_A, SFU_ROOT_A);
    const routes = new MediaRouteController({
      hostPeerId: HOST,
      assignments: initialPlan.assignments,
      revision: 4,
      sfuPublicationGeneration: GENERATION_A,
      sfuRootPeerIds: [SFU_ROOT_A],
    });
    const preparedRevision = routes.prepare(
      hybridPlan(GENERATION_B, SFU_ROOT_B),
    )!;

    expect(routes.getActiveRoute().sfu).toEqual({
      publicationGeneration: GENERATION_A,
      rootPeerIds: [SFU_ROOT_A],
    });
    expect(routes.getPendingRoute()?.route.sfu).toEqual({
      publicationGeneration: GENERATION_B,
      rootPeerIds: [SFU_ROOT_B],
    });
    expect(routes.hostActiveMediaEdges()).toBe(2);

    routes.ready(HOST, preparedRevision, "prepare");
    routes.ready(SFU_ROOT_B, preparedRevision, "prepare");
    expect(routes.commit(preparedRevision)).toBe(true);
    expect(routes.getActiveRoute().sfu).toEqual({
      publicationGeneration: GENERATION_B,
      rootPeerIds: [SFU_ROOT_B],
    });
    expect(routes.hostActiveMediaEdges()).toBe(2);
  });

  it("rejects host fanout above the configured two and inconsistent SFU ownership", () => {
    const tooManyHostEdges = new Map(hybridPlan().assignments);
    tooManyHostEdges.set(
      HOST,
      assignment(
        { kind: "none" },
        [DIRECT_ROOT, SFU_ROOT_B],
        GENERATION_A,
      ),
    );
    tooManyHostEdges.set(
      SFU_ROOT_B,
      assignment({ kind: "peer", peerId: HOST }),
    );

    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: tooManyHostEdges,
        sfuPublicationGeneration: GENERATION_A,
        sfuRootPeerIds: [SFU_ROOT_A],
      }),
    ).toThrow("Host active media edge budget exceeded");

    const nonHostPublisher = directAssignments();
    nonHostPublisher.set(
      DIRECT_ROOT,
      assignment({ kind: "peer", peerId: HOST }, [], GENERATION_A),
    );
    expect(() => controller(nonHostPublisher)).toThrow(
      "Only the host may own an SFU publication generation",
    );

    const missingRoot = hybridPlan().assignments;
    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: missingRoot,
        sfuPublicationGeneration: GENERATION_A,
        sfuRootPeerIds: [SFU_ROOT_B],
      }),
    ).toThrow("Every SFU upstream must belong to the root allowlist");

    const generationWithoutRoots = directAssignments();
    generationWithoutRoots.set(
      HOST,
      assignment(
        { kind: "none" },
        [DIRECT_ROOT, SFU_ROOT_A],
        GENERATION_A,
      ),
    );
    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: generationWithoutRoots,
        sfuPublicationGeneration: GENERATION_A,
      }),
    ).toThrow("SFU roots and publication generation must be active together");
  });

  it("does not let an explicit three-edge setting lift release role limits", () => {
    const threeHostChildren = new Map<string, ParticipantRouteAssignment>([
      [
        HOST,
        assignment(
          { kind: "none" },
          [DIRECT_ROOT, SFU_ROOT_A, THIRD_CHILD],
        ),
      ],
      [DIRECT_ROOT, assignment({ kind: "peer", peerId: HOST })],
      [SFU_ROOT_A, assignment({ kind: "peer", peerId: HOST })],
      [THIRD_CHILD, assignment({ kind: "peer", peerId: HOST })],
    ]);
    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: threeHostChildren,
        maxEndpointMediaEdges: 3,
      }),
    ).toThrow("Participant active media edge budget exceeded");

    const viewerWithTwoChildren = new Map<string, ParticipantRouteAssignment>([
      [HOST, assignment({ kind: "none" }, [DIRECT_ROOT])],
      [
        DIRECT_ROOT,
        assignment(
          { kind: "peer", peerId: HOST },
          [SFU_ROOT_A, SFU_ROOT_B],
        ),
      ],
      [SFU_ROOT_A, assignment({ kind: "peer", peerId: DIRECT_ROOT })],
      [SFU_ROOT_B, assignment({ kind: "peer", peerId: DIRECT_ROOT })],
    ]);
    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: viewerWithTwoChildren,
        maxEndpointMediaEdges: 3,
      }),
    ).toThrow("Participant active media edge budget exceeded");

    const publicationAtHostLimit = new Map<string, ParticipantRouteAssignment>([
      [
        HOST,
        assignment({ kind: "none" }, [DIRECT_ROOT], GENERATION_A),
      ],
      [DIRECT_ROOT, assignment({ kind: "peer", peerId: HOST })],
      [SFU_ROOT_A, assignment({ kind: "sfu" })],
    ]);
    const allowed = new MediaRouteController({
      hostPeerId: HOST,
      assignments: publicationAtHostLimit,
      maxEndpointMediaEdges: 3,
      sfuPublicationGeneration: GENERATION_A,
      sfuRootPeerIds: [SFU_ROOT_A],
    });
    expect(allowed.hostActiveMediaEdges()).toBe(2);

    const publicationOverHostLimit = new Map(publicationAtHostLimit);
    publicationOverHostLimit.set(
      HOST,
      assignment(
        { kind: "none" },
        [DIRECT_ROOT, THIRD_CHILD],
        GENERATION_A,
      ),
    );
    publicationOverHostLimit.set(
      THIRD_CHILD,
      assignment({ kind: "peer", peerId: HOST }),
    );
    expect(() =>
      new MediaRouteController({
        hostPeerId: HOST,
        assignments: publicationOverHostLimit,
        maxEndpointMediaEdges: 3,
        sfuPublicationGeneration: GENERATION_A,
        sfuRootPeerIds: [SFU_ROOT_A],
      }),
    ).toThrow("Host active media edge budget exceeded");
  });

  it("rejects reciprocal peer cycles", () => {
    const assignments = new Map<string, ParticipantRouteAssignment>([
      [HOST, assignment({ kind: "none" })],
      [
        SFU_ROOT_A,
        assignment({ kind: "peer", peerId: SFU_ROOT_B }, [SFU_ROOT_B]),
      ],
      [
        SFU_ROOT_B,
        assignment({ kind: "peer", peerId: SFU_ROOT_A }, [SFU_ROOT_A]),
      ],
    ]);

    expect(() => controller(assignments)).toThrow(
      "Peer media route contains a cycle",
    );
  });

  it("preserves budgets and monotonic revisions across mixed sequences", () => {
    const routes = controller();
    let previousRevision = routes.getActiveRoute().revision;

    for (let index = 0; index < 60; index += 1) {
      const plan =
        index % 2 === 0
          ? hybridPlan(GENERATION_A, SFU_ROOT_A)
          : {
              assignments: directAssignments(),
              expectedParticipantIds: new Set([HOST]),
            };
      const revision = routes.prepare(plan)!;
      expect(revision).toBeGreaterThan(previousRevision);
      expect(routes.prepare(plan)).toBeUndefined();
      expect(routes.ready(HOST, revision - 1, "prepare")).toBe(false);
      expect(routes.commit(revision - 1)).toBe(false);
      expect(routes.hostActiveMediaEdges()).toBeLessThanOrEqual(2);

      expect(routes.ready(HOST, revision, "prepare")).toBe(true);
      expect(routes.ready(HOST, revision, "prepare")).toBe(false);
      if (index % 3 === 0) {
        expect(routes.abort(revision)).toBe(true);
      } else {
        if (plan.expectedParticipantIds.has(SFU_ROOT_A)) {
          expect(routes.ready(SFU_ROOT_A, revision, "prepare")).toBe(true);
        }
        expect(routes.commit(revision)).toBe(true);
      }

      const active = routes.getActiveRoute();
      expect(active.revision).toBeGreaterThan(previousRevision);
      expect(routes.getPendingRoute()).toBeUndefined();
      expect(routes.hostActiveMediaEdges()).toBeLessThanOrEqual(2);
      previousRevision = active.revision;
    }
  });
});
