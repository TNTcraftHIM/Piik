import { describe, expect, it } from "vitest";

import {
  SfuResourceAdmission,
  type SfuResourceFence,
  type SfuSubscriptionFence,
} from "../src/server/sfu-resource-admission.ts";

function publication(
  roomId: string,
  publicationGeneration: string,
  shareGeneration = `share_${roomId}`,
): SfuResourceFence {
  return { roomId, shareGeneration, publicationGeneration };
}

function subscription(
  fence: SfuResourceFence,
  viewerPeerId: string,
): SfuSubscriptionFence {
  return { ...fence, viewerPeerId };
}

describe("SfuResourceAdmission", () => {
  it("requires explicit capacities and enforces ingress and egress independently", () => {
    for (const ingressCapacity of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => new SfuResourceAdmission({ ingressCapacity, egressCapacity: 1 }),
      ).toThrow("positive safe integer");
    }
    expect(
      () => new SfuResourceAdmission({ ingressCapacity: 1, egressCapacity: 0 }),
    ).toThrow("positive safe integer");

    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 2,
    });
    const first = publication("1", "publication_first");
    const second = publication("2", "publication_second");
    expect(admission.reservePublication(first)).toBe(true);
    expect(admission.reservePublication(second)).toBe(true);
    expect(
      admission.reservePublication(publication("3", "publication_third")),
    ).toBe(false);
    expect(admission.reserveSubscription(subscription(first, "viewer_a"))).toBe(
      true,
    );
    expect(admission.reserveSubscription(subscription(first, "viewer_b"))).toBe(
      true,
    );
    expect(
      admission.reserveSubscription(subscription(second, "viewer_c")),
    ).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 2, egress: 2 });
  });

  it("keeps exact publication and subscription operations idempotent", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 1,
      egressCapacity: 1,
    });
    const active = publication("1", "publication_active");
    const viewer = subscription(active, "viewer_a");
    expect(admission.reservePublication(active)).toBe(true);
    expect(admission.reservePublication({ ...active })).toBe(true);
    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.reserveSubscription({ ...viewer })).toBe(true);
    expect(admission.commitSubscription(viewer)).toBe(false);
    expect(admission.commitPublication(active)).toEqual([]);
    expect(admission.commitPublication({ ...active })).toEqual([]);
    expect(admission.commitSubscription(viewer)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 1 });

    const stale = publication("1", "publication_stale");
    expect(admission.reserveSubscription(subscription(stale, "viewer_a"))).toBe(
      false,
    );
    expect(admission.commitPublication(stale)).toBeNull();
    expect(admission.commitSubscription(subscription(active, "viewer_b"))).toBe(
      false,
    );
    expect(admission.releaseSubscription(subscription(active, "viewer_b"))).toBe(
      false,
    );
    expect(admission.beginDrain(stale)).toBe(false);
  });

  it("does not commit a publication without its first exact subscription", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 1,
      egressCapacity: 1,
    });
    const pending = publication("1", "publication_pending");
    expect(admission.reservePublication(pending)).toBe(true);
    expect(admission.commitPublication(pending)).toBeNull();
    expect(admission.beginDrain(pending)).toBe(true);
    expect(admission.completeDrain(pending)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

  it("commits a new publication and its subscriptions before draining the old generation", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 3,
    });
    const first = publication("1", "publication_first");
    const second = publication("1", "publication_second");
    const firstViewer = subscription(first, "viewer_a");
    expect(admission.reservePublication(first)).toBe(true);
    expect(admission.reserveSubscription(firstViewer)).toBe(true);
    expect(admission.commitPublication(first)).toEqual([]);

    expect(admission.reservePublication(second)).toBe(true);
    expect(admission.reserveSubscription(subscription(second, "viewer_b"))).toBe(
      true,
    );
    expect(admission.reserveSubscription(subscription(second, "viewer_c"))).toBe(
      true,
    );
    expect(admission.usage()).toEqual({ ingress: 2, egress: 3 });
    expect(admission.commitPublication(second)).toEqual([first]);
    expect(admission.commitSubscription(subscription(second, "viewer_b"))).toBe(
      true,
    );
    expect(admission.reservePublication(first)).toBe(false);
    expect(admission.reserveSubscription(firstViewer)).toBe(false);

    expect(admission.completeDrain(first)).toBe(true);
    expect(admission.completeDrain(first)).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 2 });
  });

  it("keeps a released reserved subscription charged until publication absence", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 1,
      egressCapacity: 2,
    });
    const active = publication("1", "publication_active");
    const first = subscription(active, "viewer_a");
    const candidate = subscription(active, "viewer_b");
    expect(admission.reservePublication(active)).toBe(true);
    expect(admission.reserveSubscription(first)).toBe(true);
    expect(admission.commitPublication(active)).toEqual([]);

    expect(admission.reserveSubscription(candidate)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 2 });
    expect(admission.releaseSubscription(candidate)).toBe(true);
    expect(admission.releaseSubscription(candidate)).toBe(true);
    expect(admission.commitSubscription(candidate)).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 2 });
    expect(
      admission.reserveSubscription(subscription(active, "viewer_c")),
    ).toBe(false);
    expect(admission.beginDrain(active)).toBe(true);
    expect(admission.completeDrain(active)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

  it("reactivates a draining subscription in the current generation without double charging", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 1,
      egressCapacity: 1,
    });
    const active = publication("1", "publication_active");
    const viewer = subscription(active, "viewer_a");
    expect(admission.reservePublication(active)).toBe(true);
    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.commitPublication(active)).toEqual([]);
    expect(admission.releaseSubscription(viewer)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 1 });

    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 1 });
    expect(admission.releaseSubscription(viewer)).toBe(true);
    expect(
      admission.reserveSubscription(subscription(active, "viewer_b")),
    ).toBe(false);
    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.commitSubscription(viewer)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 1 });
  });

  it("keeps departed subscription egress charged until publication drain proof", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 1,
      egressCapacity: 1,
    });
    const active = publication("1", "publication_active");
    const viewer = subscription(active, "viewer_a");
    expect(admission.reservePublication(active)).toBe(true);
    expect(admission.reserveSubscription(viewer)).toBe(true);
    expect(admission.commitPublication(active)).toEqual([]);
    expect(admission.releaseSubscription(viewer)).toBe(true);
    expect(
      admission.reserveSubscription(subscription(active, "viewer_b")),
    ).toBe(false);
    expect(admission.beginDrain(active)).toBe(true);
    expect(admission.beginDrain(active)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 1 });
    expect(admission.completeDrain(active)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

  it("drains every reserved and committed generation exactly once", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 3,
      egressCapacity: 4,
    });
    const active = publication("1", "publication_active");
    const replacement = publication("1", "publication_replacement");
    const other = publication("2", "publication_other");
    expect(admission.reservePublication(active)).toBe(true);
    expect(admission.reserveSubscription(subscription(active, "viewer_a"))).toBe(
      true,
    );
    expect(admission.commitPublication(active)).toEqual([]);
    expect(admission.reservePublication(replacement)).toBe(true);
    expect(
      admission.reserveSubscription(subscription(replacement, "viewer_b")),
    ).toBe(true);
    expect(admission.reservePublication(other)).toBe(true);
    expect(admission.reserveSubscription(subscription(other, "viewer_c"))).toBe(
      true,
    );

    const firstRoom = admission.beginDrainRoom("1");
    expect(firstRoom).toEqual([active, replacement]);
    expect(admission.beginDrainRoom("1")).toEqual(firstRoom);
    expect(admission.beginDrainAll()).toEqual([active, replacement, other]);
    expect(admission.usage()).toEqual({ ingress: 3, egress: 3 });
    for (const fence of [active, replacement, other]) {
      expect(admission.completeDrain(fence)).toBe(true);
      expect(admission.completeDrain(fence)).toBe(false);
    }
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

});
