import type { ServerMessage } from "../../shared/protocol";

const AUTHORITY_MESSAGE_TYPES = new Set<ServerMessage["type"]>([
  "authenticated",
  "host-status",
  "sharing-stopped",
  "viewer-grant-revoked",
  "room-closed",
  "error",
]);

export class ViewerMessageAuthority {
  private generation = 0;

  tokenFor(message: ServerMessage): number {
    if (AUTHORITY_MESSAGE_TYPES.has(message.type)) {
      this.generation += 1;
    }
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  owns(token: number): boolean {
    return token === this.generation;
  }
}
