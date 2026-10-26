import { useSyncExternalStore } from "react";
import type { ClientMessage, ServerMessage, RoomControlState, RoomControlCommand } from "../../shared/protocol";
import { writeHostRoom, clearHostRoom, releaseHostRoom } from "./session";

interface MemberCredential { clientId: string; token: string; ownerToken?: string }
const memberKey = (roomId: string) => `piik.room-member.${roomId}`;
export function readMemberCredential(roomId: string): MemberCredential | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(memberKey(roomId)) ?? "null");
    return value && typeof value.clientId === "string" && typeof value.token === "string" ? value : null;
  } catch { return null; }
}
export function saveMemberCredential(roomId: string, value: MemberCredential): void {
  sessionStorage.setItem(memberKey(roomId), JSON.stringify(value));
}

export interface RoomControlSnapshot {
  peerId: string | null;
  state: RoomControlState | null;
  connected: boolean;
  error: "not-allowed" | "member-unavailable" | "changed" | "storage-failed" | null;
  accepting: boolean;
}
export class RoomControlSession {
  private snapshot: RoomControlSnapshot = { peerId: null, state: null, connected: false, error: null, accepting: false };
  private listeners = new Set<() => void>();
  private offer: Extract<ServerMessage, { type: "room-ownership-offer" }> | null = null;
  canonicalUrl: string;
  ownerToken: string | null;
  constructor(readonly roomId: string, private readonly send: (message: ClientMessage) => boolean, ownerToken: string | null = null) {
    this.canonicalUrl = new URL(`/r/${roomId}`, window.location.href).href;
    this.ownerToken = ownerToken;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<RoomControlSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(listener => listener()); }
  authenticated(peerId: string) { this.update({ peerId, connected: true }); this.send({ type: "subscribe-room-control" }); }
  disconnected() { this.update({ connected: false }); }
  close() { this.disconnected(); if (this.ownerToken) releaseHostRoom({ roomId: this.roomId, hostToken: this.ownerToken }); }
  reportChanged() { this.update({ error: "changed" }); }
  command(command: RoomControlCommand) {
    this.update({ error: null });
    if (!this.send({ type: "room-control-command", command })) this.update({ error: "changed" });
  }
  async accept(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.snapshot.accepting) return;
    this.update({ accepting: true, error: null });
    try {
      // Persist the replacement credential before allowing the server to retire
      // the old one. Losing this tab after the acknowledgment remains recoverable.
      if (!await writeHostRoom({ roomId: this.roomId, hostToken: offer.token, canonicalUrl: this.canonicalUrl }, () => this.offer === offer && this.snapshot.connected)) throw new Error("Room credential unavailable");
      const credential = readMemberCredential(this.roomId);
      if (!credential) throw new Error("Room session unavailable");
      saveMemberCredential(this.roomId, { ...credential, ownerToken: offer.token });
      this.ownerToken = offer.token;
      this.command({ action: "accept-transfer", offerId: offer.offerId });
    } catch { this.update({ error: "storage-failed" }); }
    finally { this.update({ accepting: false }); }
  }
  receive(message: ServerMessage): boolean {
    if (message.type === "room-ownership-offer") { this.offer = message; return true; }
    if (message.type === "room-control-error") { this.update({ error: message.code }); return false; }
    if (message.type !== "room-control-state") return false;
    const isOwner = message.ownerPeerId === this.snapshot.peerId;
    if (!isOwner && this.ownerToken && (this.offer === null || message.transfer?.id !== this.offer.offerId)) {
      this.ownerToken = null;
      clearHostRoom();
      const credential = readMemberCredential(this.roomId);
      if (credential) try { saveMemberCredential(this.roomId, { clientId: credential.clientId, token: credential.token }); } catch { /* Existing room admission remains live. */ }
    }
    if (message.transfer?.id !== this.offer?.offerId) this.offer = null;
    this.update({ state: message });
    return true;
  }
}

const emptyControl: RoomControlSnapshot = { peerId: null, state: null, connected: false, error: null, accepting: false };
const noopSubscribe = () => () => {};
const emptySnapshot = () => emptyControl;
export function useRoomControl(session: RoomControlSession | null) { return useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getSnapshot ?? emptySnapshot); }
