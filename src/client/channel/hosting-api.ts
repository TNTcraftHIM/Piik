import { z } from "zod";
import { roomSchema, roomSummarySchema, type RoomSummary } from "./protocol";
import { RoomCreationInterrupted } from "./room-creation";

const descriptionSchema = z.object({ sessionId: z.uuid(), roomIds: z.array(roomSchema.shape.id) });
export type NativeHostingDescription = z.infer<typeof descriptionSchema>;

export type RoomRestoreRecovery = "room_restore_unconfirmed" | "room_restored_connection_failed";
export function roomRestoreRecovery(error: unknown): RoomRestoreRecovery | null {
  if (!(error instanceof Error)) return null;
  return error.message === "room_restore_unconfirmed" || error.message === "room_restored_connection_failed" ? error.message : null;
}

/** The Native operator reports its live identity; a connected App alone is not room ownership. */
export class NativeRoomHosting {
  constructor(private readonly roomsURL: string, private readonly authorization: HeadersInit,
    private readonly descriptionURL = `${roomsURL}/hosting`) {}

  async describe(signal?: AbortSignal): Promise<NativeHostingDescription> {
    return descriptionSchema.parse(await (await hostingRequest(this.descriptionURL, this.authorization, undefined, signal)).json());
  }

  async snapshot(roomId: string): Promise<Blob> {
    return (await hostingRequest(`${this.roomsURL}/${encodeURIComponent(roomId)}/backup`, this.authorization)).blob();
  }

  async restore(archive: Blob, roomId?: string): Promise<RoomSummary> {
    const url = roomId === undefined ? `${this.roomsURL}/backup` : `${this.roomsURL}/${encodeURIComponent(roomId)}/backup`;
    const response = await fetchHosting(url, this.authorization, archive).catch(() => null);
    const value: unknown = await response?.json().catch(() => null);
    if (response?.ok) {
      const result = z.object({ room: roomSummarySchema }).safeParse(value);
      if (result.success) return result.data.room;
    } else if (response && response.status >= 400) {
      const failure = failureSchema.safeParse(value);
      if (failure.success && (response.status < 500 || (response.status === 507 && failure.data.error === "restore_scratch_limit")))
        throw new Error(failure.data.error);
    }
    throw new Error("room_restore_unconfirmed");
  }

  async importCopy(archive: Blob, creatorId: string, sessionId: string): Promise<RoomSummary> {
    const headers = new Headers(this.authorization);
    headers.set("X-Piik-Session", sessionId);
    headers.set("Content-Type", "application/zip");
    const response = await fetch(`${this.roomsURL}/copy`, { method: "POST", headers, body: archive }).catch(() => null);
    const value: unknown = await response?.json().catch(() => null);
    if (response?.ok) {
      const result = z.object({ room: roomSummarySchema }).safeParse(value);
      if (result.success && result.data.room.creatorId === creatorId) return result.data.room;
    } else if (response) {
      const failure = failureSchema.extend({ roomId: roomSchema.shape.id.optional() }).safeParse(value);
      if (failure.success) {
        if (failure.data.error === "room_created_connection_failed")
          throw new RoomCreationInterrupted(failure.data.roomId, true);
        if (failure.data.error === "room_creation_unconfirmed")
          throw new RoomCreationInterrupted(failure.data.roomId, false);
        if ((response.status >= 400 && response.status < 500) || failure.data.error === "hosting_unavailable"
          || (response.status === 507 && failure.data.error === "restore_scratch_limit"))
          throw new Error(failure.data.error);
        throw new RoomCreationInterrupted(failure.data.roomId, false);
      }
    }
    throw new RoomCreationInterrupted(undefined, false);
  }
}

/** Domain authority is restored by its same-origin service, independently of room hosts. */
export class NativeDomainHosting {
  constructor(private readonly authorization: HeadersInit) {}

  async snapshot(): Promise<Blob> {
    return (await hostingRequest("/prototype/channel/backup", this.authorization)).blob();
  }

  async restore(archive: Blob): Promise<string> {
    const value: unknown = await (await hostingRequest("/prototype/channel/backup", this.authorization, archive)).json();
    return z.object({ domainId: z.uuid() }).parse(value).domainId;
  }
}

async function hostingRequest(url: string, authorization: HeadersInit, archive?: Blob, signal?: AbortSignal): Promise<Response> {
  const response = await fetchHosting(url, authorization, archive, signal);
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const failure = failureSchema.safeParse(value);
    throw new Error(failure.success ? failure.data.error : "backup_failed");
  }
  return response;
}

const failureSchema = z.object({ error: z.string().min(1) });

function fetchHosting(url: string, authorization: HeadersInit, archive?: Blob, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers(authorization);
  if (archive) headers.set("Content-Type", "application/zip");
  return fetch(url, { method: archive ? "PUT" : "GET", headers, body: archive, signal });
}
