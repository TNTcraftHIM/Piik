import { describe, expect, it } from "vitest";

import type { SignalPayload } from "../src/shared/protocol.ts";
import {
  limitMediaAssignment,
  MAX_HOST_MEDIA_CHILDREN,
  MAX_VIEWER_MEDIA_CHILDREN,
  reconcileBoundedMediaChildren,
  viewerRestartMessage,
  viewerSignalMessage,
} from "../src/client/webrtc/media-assignment.ts";

const offer: SignalPayload = {
  kind: "description",
  connectionId: "connection_12345678",
  description: { type: "offer", sdp: "test-offer" },
};

describe("peer-assisted client assignment", () => {
  it("keeps host and viewer child counts within their client limits", () => {
    const assignment = {
      parentPeerId: "parent_12345678",
      childPeerIds: [
        "child_12345678",
        "child_abcdefgh",
        "child_12345678",
      ],
    };

    expect(
      limitMediaAssignment(assignment, MAX_HOST_MEDIA_CHILDREN),
    ).toEqual({
      parentPeerId: "parent_12345678",
      childPeerIds: ["child_12345678", "child_abcdefgh"],
    });
    expect(
      limitMediaAssignment(assignment, MAX_VIEWER_MEDIA_CHILDREN),
    ).toEqual({
      parentPeerId: "parent_12345678",
      childPeerIds: ["child_12345678"],
    });
  });

  it("removes stale host edges before starting replacement children", () => {
    const operations: string[] = [];

    reconcileBoundedMediaChildren(
      new Set(["old-child", "kept-child"]),
      ["kept-child", "new-child", "overflow-child"],
      MAX_HOST_MEDIA_CHILDREN,
      (peerId) => operations.push(`remove:${peerId}`),
      (peerId) => operations.push(`start:${peerId}`),
    );

    expect(operations).toEqual([
      "remove:old-child",
      "start:kept-child",
      "start:new-child",
    ]);
  });

  it("leaves ordinary viewer signaling untargeted", () => {
    expect(viewerSignalMessage(false, "host_12345678", offer)).toEqual({
      type: "signal",
      payload: offer,
    });
    expect(
      viewerRestartMessage(
        false,
        "host_12345678",
        "connection_12345678",
        true,
      ),
    ).toEqual({
      type: "restart-request",
      connectionId: "connection_12345678",
      rebuild: true,
    });
  });

  it("targets peer-assisted signaling at the assigned parent", () => {
    expect(viewerSignalMessage(true, "parent_12345678", offer)).toEqual({
      type: "signal",
      targetPeerId: "parent_12345678",
      payload: offer,
    });
    expect(
      viewerRestartMessage(
        true,
        "parent_12345678",
        "connection_12345678",
        false,
      ),
    ).toEqual({
      type: "restart-request",
      targetPeerId: "parent_12345678",
      connectionId: "connection_12345678",
      rebuild: false,
    });
  });
});
