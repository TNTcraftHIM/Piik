import { describe, expect, it } from "vitest";

import {
  SfuResourceAdmission,
  type SfuResourceFence,
} from "../src/server/sfu-resource-admission.ts";

function fence(
  roomId: string,
  publicationGeneration: string,
  shareGeneration = `share_${roomId}`,
): SfuResourceFence {
  return { roomId, shareGeneration, publicationGeneration };
}

describe("SfuResourceAdmission", () => {
  it("requires explicit positive safe capacities", () => {
    for (const ingressCapacity of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => new SfuResourceAdmission({ ingressCapacity, egressCapacity: 1 }),
      ).toThrow("positive safe integer");
    }
    expect(
      () => new SfuResourceAdmission({ ingressCapacity: 1, egressCapacity: 0 }),
    ).toThrow("positive safe integer");
  });

  it("enforces deployment-wide ingress and egress across rooms", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 4,
    });
    expect(admission.reserve(fence("1", "publication_a"), 2)).toBe(true);
    expect(admission.reserve(fence("2", "publication_b"), 2)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 2, egress: 4 });

    expect(admission.reserve(fence("3", "publication_c"), 1)).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 2, egress: 4 });
  });

  it("charges old and candidate generations until exact commit", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 5,
    });
    const first = fence("1", "publication_first");
    const second = fence("1", "publication_second");
    expect(admission.reserve(first, 1)).toBe(true);
    expect(admission.commit(first)).toBe(true);
    expect(admission.reserve(second, 2)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 2, egress: 3 });

    expect(admission.commit(fence("1", "publication_stale"))).toBe(false);
    expect(admission.commit(second)).toBe(true);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 2 });
    expect(admission.release(first)).toBe(false);
  });

  it("makes duplicate operations idempotent without weakening fences", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 3,
    });
    const pending = fence("1", "publication_pending");
    expect(admission.reserve(pending, 2)).toBe(true);
    expect(admission.reserve(pending, 2)).toBe(true);
    expect(admission.reserve(pending, 1)).toBe(false);
    expect(admission.reserve(fence("1", "publication_other"), 1)).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 1, egress: 2 });

    expect(admission.release(pending)).toBe(true);
    expect(admission.release(pending)).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

  it("releases a room's committed and reserved resources together", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 4,
    });
    const active = fence("1", "publication_active");
    expect(admission.reserve(active, 1)).toBe(true);
    expect(admission.commit(active)).toBe(true);
    expect(admission.reserve(fence("1", "publication_candidate"), 2)).toBe(
      true,
    );

    expect(admission.releaseRoom("1")).toBe(true);
    expect(admission.releaseRoom("1")).toBe(false);
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });

  it("releases every room when its process owner closes", () => {
    const admission = new SfuResourceAdmission({
      ingressCapacity: 2,
      egressCapacity: 3,
    });
    const active = fence("1", "publication_active");
    expect(admission.reserve(active, 1)).toBe(true);
    expect(admission.commit(active)).toBe(true);
    expect(admission.reserve(fence("2", "publication_pending"), 2)).toBe(
      true,
    );

    admission.releaseAll();
    admission.releaseAll();
    expect(admission.usage()).toEqual({ ingress: 0, egress: 0 });
  });
});
