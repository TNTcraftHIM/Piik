import { z } from "zod";
import { roomSchema, roomSummarySchema, type RoomSummary } from "./protocol";

const descriptionSchema = z.object({ sessionId: z.uuid(), roomIds: z.array(roomSchema.shape.id) });
export type NativeHostingDescription = z.infer<typeof descriptionSchema>;

/** The Native operator reports its live identity; a connected App alone is not room ownership. */
export class NativeRoomHosting {
  constructor(private readonly roomsURL: string, private readonly authorization: HeadersInit,
    private readonly descriptionURL = `${roomsURL}/hosting`) {}

  async describe(): Promise<NativeHostingDescription> {
    return descriptionSchema.parse(await (await this.request(this.descriptionURL)).json());
  }

  async snapshot(roomId: string): Promise<Blob> {
    return (await this.request(`${this.roomsURL}/${encodeURIComponent(roomId)}/backup`)).blob();
  }

  async restore(archive: Blob): Promise<RoomSummary> {
    const value: unknown = await (await this.request(`${this.roomsURL}/backup`, archive)).json();
    return z.object({ room: roomSummarySchema }).parse(value).room;
  }

  private async request(url: string, archive?: Blob): Promise<Response> {
    const headers = new Headers(this.authorization);
    if (archive) headers.set("Content-Type", "application/zip");
    const response = await fetch(url, { method: archive ? "PUT" : "GET", headers, body: archive });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => null);
      const failure = z.object({ error: z.string() }).safeParse(value);
      throw new Error(failure.success ? failure.data.error : "backup_failed");
    }
    return response;
  }
}
