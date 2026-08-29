import { describe, expect, it } from "vitest";

import type { SignalPayload } from "../src/shared/protocol.ts";
import {
  createOwnedViewerRestartSender,
  limitMediaAssignment,
  MAX_ENDPOINT_MEDIA_CHILDREN,
  reconcileBoundedMediaChildren,
  retainSelectedMediaParent,
  viewerRestartMessage,
  viewerSignalMessage,
} from "../src/client/webrtc/media-assignment.ts";

const offer: SignalPayload = {
  kind: "description",
  connectionId: "connection_12345678",
  description: { type: "offer", sdp: "test-offer" },
};

describe("peer-assisted client assignment", () => {
  it("keeps endpoint child counts within the shared client limit", () => {
    expect(MAX_ENDPOINT_MEDIA_CHILDREN).toBe(3);

    const assignment = {
      parentPeerId: "parent_12345678",
      childPeerIds: [
        "child_12345678",
        "child_abcdefgh",
        "child_qwertyui",
        "child_12345678",
        "child_overflow",
      ],
    };

    expect(
      limitMediaAssignment(assignment, MAX_ENDPOINT_MEDIA_CHILDREN),
    ).toEqual({
      parentPeerId: "parent_12345678",
      childPeerIds: [
        "child_12345678",
        "child_abcdefgh",
        "child_qwertyui",
      ],
    });
  });

  it("removes stale host edges before starting replacement children", () => {
    const operations: string[] = [];

    reconcileBoundedMediaChildren(
      new Set(["old-child", "kept-child"]),
      ["kept-child", "new-child", "overflow-child"],
      MAX_ENDPOINT_MEDIA_CHILDREN,
      (peerId) => operations.push(`remove:${peerId}`),
      (peerId) => operations.push(`start:${peerId}`),
    );

    expect(operations).toEqual([
      "remove:old-child",
      "start:kept-child",
      "start:new-child",
      "start:overflow-child",
    ]);
  });

  it("updates selected Viewer children without replacing its retained parent", () => {
    expect(
      retainSelectedMediaParent(
        {
          parentPeerId: null,
          childPeerIds: ["new-child_12345678"],
        },
        "selected-parent_12345678",
      ),
    ).toEqual({
      parentPeerId: "selected-parent_12345678",
      childPeerIds: ["new-child_12345678"],
    });
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

  it("allows a pending peer restart closure only after exact promotion", () => {
    let active = false;
    const messages: unknown[] = [];
    const sendRestart = createOwnedViewerRestartSender(
      true,
      (targetPeerId, connectionId) =>
        active &&
        targetPeerId === "parent_12345678" &&
        connectionId === "connection_12345678",
      (message) => {
        messages.push(message);
        return true;
      },
    );

    expect(
      sendRestart("parent_12345678", "connection_12345678", false),
    ).toBe(false);
    expect(messages).toEqual([]);

    active = true;
    expect(
      sendRestart("parent_12345678", "connection_12345678", true),
    ).toBe(true);
    expect(messages).toEqual([
      {
        type: "restart-request",
        targetPeerId: "parent_12345678",
        connectionId: "connection_12345678",
        rebuild: true,
      },
    ]);
    expect(sendRestart("other-parent", "connection_12345678", true)).toBe(
      false,
    );
  });
});
