import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string(), roomId: z.string(), userId: z.string(), name: z.string(),
  size: z.number().nonnegative(), mediaType: z.string(), createdAt: z.number(),
});
export const attachmentLimitsSchema = z.object({
  maxFileBytes: z.number().positive(), totalBytes: z.number().positive(),
  maxStoredFiles: z.number().positive(), maxAttachmentsPerMessage: z.number().positive(),
});
export type ChannelAttachment = z.infer<typeof attachmentSchema>;
export type AttachmentLimits = z.infer<typeof attachmentLimitsSchema>;

/** The existing channel credential authorizes HTTP transfer; it never enters a URL. */
export class ChannelAttachments {
  constructor(private credential: () => string | undefined, private available: (roomId: string) => boolean = () => true) {}

  private roomRequest(roomId: string, path: string, options: RequestInit = {}): Promise<Response> {
    if (!this.available(roomId)) return Promise.reject(new Error("attachments_unavailable"));
    return this.request(path, options);
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    const credential = this.credential();
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    const response = await fetch(`/prototype/channel/${path}`, { ...options, headers, cache: "no-store" });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(typeof result?.code === "string" ? result.code : "transfer_failed");
    }
    return response;
  }

  limits = async (signal?: AbortSignal): Promise<AttachmentLimits> =>
    attachmentLimitsSchema.parse(await (await this.request("limits", { signal })).json());

  upload = async (roomId: string, file: File, signal?: AbortSignal): Promise<ChannelAttachment> =>
    attachmentSchema.parse(await (await this.roomRequest(roomId, `rooms/${encodeURIComponent(roomId)}/attachments`, {
      method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name) }, body: file, signal,
    })).json());

  metadata = async (roomId: string, id: string, signal?: AbortSignal): Promise<ChannelAttachment> =>
    attachmentSchema.parse(await (await this.roomRequest(roomId, `attachments/${encodeURIComponent(id)}`, { signal })).json());

  content = async (roomId: string, id: string, signal?: AbortSignal): Promise<Blob> =>
    (await this.roomRequest(roomId, `attachments/${encodeURIComponent(id)}/content`, { signal })).blob();

  discardDraft = async (roomId: string, id: string): Promise<void> => {
    try { await this.roomRequest(roomId, `attachments/${encodeURIComponent(id)}?draft=true`, { method: "DELETE" }); }
    catch (error) {
      // A lost chat acknowledgement can leave an already-sent file in the composer.
      if (!(error instanceof Error) || !["attachment_already_sent", "attachment_unavailable"].includes(error.message)) throw error;
    }
  };
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
}
