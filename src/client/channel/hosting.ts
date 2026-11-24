import { isDeferredModuleFailure } from "../lib/deferred-module-failure";

type RoomHosting = typeof import("../../../prototype/channel-browser/src/room-host");

const roomHostingModules = import.meta.glob<RoomHosting>("../../../prototype/channel-browser/src/room-host.ts");

/** Vite bundles the real adapter only for entries that use the channel client. */
export async function loadRoomHosting(): Promise<RoomHosting> {
  if (typeof WebAssembly === "undefined") throw new Error("webassembly_unavailable");
  try { return await roomHostingModules["../../../prototype/channel-browser/src/room-host.ts"](); }
  catch (error) {
    if (isDeferredModuleFailure(error)) throw error;
    throw new Error("room_runtime_unavailable");
  }
}

export function roomDatabaseName(channelId: string, userId: string): string {
  return `piik.channel.rooms.${channelId}.${userId}`;
}
