import { describe, expect, it } from "vitest";

import {
  assertEndpointMediaCopyCapacity,
  countEndpointMediaCopies,
  endpointMediaCopyCountFits,
  endpointMediaCopyLimit,
} from "../src/shared/media-copy-accounting.ts";

describe("endpoint media copy accounting", () => {
  it("counts children and one Host publication while upstream remains free", () => {
    expect(
      countEndpointMediaCopies({
        childPeerIds: ["child-a", "child-b"],
      }),
    ).toBe(2);
    expect(
      countEndpointMediaCopies({
        childPeerIds: ["child-a", "child-b"],
        publicationGeneration: "publication-a",
      }),
    ).toBe(3);
  });

  it("does not double-count a committed selected transport for the same edge", () => {
    expect(
      countEndpointMediaCopies({
        childPeerIds: ["child-a"],
        selectedChildPeerIds: ["child-a"],
      }),
    ).toBe(1);
  });

  it("charges each hidden carried selected edge as another copy", () => {
    expect(
      countEndpointMediaCopies({
        childPeerIds: ["child-a"],
        selectedChildPeerIds: ["child-b", "child-b", "child-c"],
      }),
    ).toBe(3);
  });

  it.each([
    [1, null, ["selected-a"]],
    [2, "publication", ["selected-a"]],
    [3, "publication", ["selected-a", "selected-b"]],
  ] as const)(
    "holds hidden selected carries to endpoint cap %i",
    (capacity, publicationGeneration, selectedChildPeerIds) => {
      const atCapacity = countEndpointMediaCopies({
        childPeerIds: [],
        publicationGeneration,
        selectedChildPeerIds,
      });
      const overCapacity = countEndpointMediaCopies({
        childPeerIds: [],
        publicationGeneration,
        selectedChildPeerIds: [...selectedChildPeerIds, "selected-overflow"],
      });

      expect(atCapacity).toBe(capacity);
      expect(endpointMediaCopyCountFits(atCapacity, capacity)).toBe(true);
      expect(endpointMediaCopyCountFits(overCapacity, capacity)).toBe(false);
    },
  );

  it.each([
    [1, 1, 2],
    [2, 2, 3],
    [3, 3, 3],
  ] as const)(
    "bounds capacity %i at %i steady and %i during transition",
    (capacity, steady, transition) => {
      expect(endpointMediaCopyLimit(capacity, "steady")).toBe(steady);
      expect(endpointMediaCopyLimit(capacity, "transition")).toBe(transition);
      expect(
        endpointMediaCopyCountFits(transition, capacity, "transition"),
      ).toBe(true);
      expect(
        endpointMediaCopyCountFits(transition + 1, capacity, "transition"),
      ).toBe(false);
    },
  );

  it.each([0, 4, 1.5, Number.NaN])(
    "rejects invalid capacity %s",
    (capacity) => {
      expect(() => assertEndpointMediaCopyCapacity(capacity)).toThrow(
        "must be 1, 2, or 3",
      );
    },
  );

  it("returns false instead of throwing for an unavailable runtime capacity", () => {
    expect(endpointMediaCopyCountFits(0, 0)).toBe(false);
  });
});
