import { z } from "zod";
import { roomSchema, roomSummarySchema, type RoomSummary } from "./protocol";

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
    return (await this.request(`${this.roomsURL}/${encodeURIComponent(roomId)}/backup`)).blob();
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

  private async request(url: string, archive?: Blob): Promise<Response> {
    return hostingRequest(url, this.authorization, archive);
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
