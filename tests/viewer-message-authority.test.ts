import { describe, expect, it } from "vitest";

import { ViewerMessageAuthority } from "../src/client/media/viewer-message-authority.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

function message(type: ServerMessage["type"]): ServerMessage {
  return { type } as ServerMessage;
}

describe("ViewerMessageAuthority", () => {
  it("invalidates an awaited authenticated continuation on newer authority", () => {
    const authority = new ViewerMessageAuthority();
    const authenticated = authority.tokenFor(message("authenticated"));

    expect(authority.tokenFor(message("route-update"))).toBe(authenticated);
    expect(authority.owns(authenticated)).toBe(true);

    authority.tokenFor(message("sharing-stopped"));
    expect(authority.owns(authenticated)).toBe(false);
  });

  it("invalidates pending work on a newer auth or termination", () => {
    const authority = new ViewerMessageAuthority();
    const first = authority.tokenFor(message("authenticated"));
    authority.tokenFor(message("room-closed"));
    expect(authority.owns(first)).toBe(false);

    const second = authority.tokenFor(message("authenticated"));
    authority.invalidate();
    expect(authority.owns(second)).toBe(false);
  });

  it("invalidates an awaited continuation when Viewer access is revoked", () => {
    const authority = new ViewerMessageAuthority();
    const authenticated = authority.tokenFor(message("authenticated"));

    authority.tokenFor(message("viewer-access-revoked"));

    expect(authority.owns(authenticated)).toBe(false);
  });
});
