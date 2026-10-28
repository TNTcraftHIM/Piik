import type { RoomSettings, RoomSummary } from "./protocol";

export interface HostedRoom {
  readonly roomId: string;
  summary(): RoomSummary;
  bind(bindingId: string): Promise<void>;
  dispatch(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface RoomHosting {
  initializeFiles(): Promise<void>;
  FileDelivery: new (sessionId: string) => FileDelivery;
  AttachmentHash: new () => AttachmentHash;
  attachment_media_type(bytes: Uint8Array): string;
  attachment_limits(): string;
  createRoomPolicy(input: RoomSettings & { id: string; creatorId: string }): Promise<string>;
  BrowserRoomHost: {
    open(databaseName: string, policy: string): Promise<HostedRoom>;
    storedPolicies(databaseName: string): Promise<string[]>;
  };
}

export interface AttachmentHash {
  update(bytes: Uint8Array): void;
  finish(): string;
  free(): void;
}
export interface FileDelivery {
  update(plans: string): string;
  control(peer: string, control: string): string;
  chunk(peer: string, frame: Uint8Array): string;
  read_result(key: string, offset: bigint, bytes: Uint8Array): string;
  written(key: string, offset: bigint, length: number): string;
  fail(key: string, code: string): string;
  peer_unavailable(peer: string): string;
  peer_failed(key: string, peer: string, code: string): string;
  start(key: string): string;
  cancel(key: string): string;
  free(): void;
}

/** The isolated prototype loads the real adapter without making the 2.x build require WASM tools. */
export async function loadRoomHosting(): Promise<RoomHosting> {
  const source = "/prototype/channel-browser/src/room-host.ts";
  try { return await import(/* @vite-ignore */ source); }
  catch { throw new Error("room_runtime_unavailable"); }
}

export function roomDatabaseName(channelId: string, userId: string): string {
  return `piik.channel.rooms.${channelId}.${userId}`;
}
