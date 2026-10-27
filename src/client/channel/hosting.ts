import type { RoomSettings, RoomSummary } from "./protocol";

export interface HostedRoom {
  readonly roomId: string;
  summary(): RoomSummary;
  bind(bindingId: string): Promise<void>;
  dispatch(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface RoomHosting {
  createRoomPolicy(input: RoomSettings & { id: string; creatorId: string }): Promise<string>;
  BrowserRoomHost: {
    open(databaseName: string, policy: string): Promise<HostedRoom>;
    storedPolicies(databaseName: string): Promise<string[]>;
  };
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
