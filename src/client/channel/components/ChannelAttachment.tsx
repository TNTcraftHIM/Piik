import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelAttachment as Attachment, ImageRendition } from "../protocol";
import { type ChannelAttachments, fileSize } from "../attachments";
import { inlineImageFile } from "../image-preview";
import { ChannelAction } from "./ChannelAction";
import { Tooltip } from "../../components/living/Tooltip";
import { ChannelImageDialog } from "./ChannelImageDialog";

export function ChannelAttachment({ roomId, messageSeq, file, client, inlineImage }: {
  roomId: string; messageSeq: number; file: Attachment; client: ChannelAttachments; inlineImage?: ImageRendition;
}) {
  const { t } = useCopy();
  const key = { roomId, messageSeq, attachmentId: file.id };
  const download = useSyncExternalStore(client.subscribe, () => client.status(key));
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [originalShown, setOriginalShown] = useState(false);
  const resource = useRef<{ request: AbortController; url: string | null } | null>(null);
  useEffect(() => {
    const current = { request: new AbortController(), url: null as string | null };
    resource.current = current;
    setPreview(null); setPreviewBusy(false); setPreviewFailed(false); setOriginalFailed(false); setImageOpen(false); setOriginalShown(inlineImage?.original ?? false);
    if (inlineImage !== undefined && file.mediaType.startsWith("image/")) {
      try { current.url = URL.createObjectURL(inlineImageFile(inlineImage, file.name)); setPreview(current.url); }
      catch { setPreviewFailed(true); }
    }
    return () => { current.request.abort(); if (current.url) URL.revokeObjectURL(current.url); };
  }, [roomId, messageSeq, file.id, client, inlineImage]);
  async function showImage() {
    const current = resource.current;
    if (!current || previewBusy) return;
    setPreviewBusy(true); setPreviewFailed(false); setOriginalFailed(false);
    const request = current.request;
    let candidate: string | null = null;
    try {
      const verified = await client.content(key, file, request.signal, inlineImage);
      if (request.signal.aborted) return;
      candidate = URL.createObjectURL(verified);
      const image = new Image(); image.src = candidate;
      await image.decode();
      if (request.signal.aborted || resource.current !== current || current.request !== request) return;
      if (current.url) URL.revokeObjectURL(current.url);
      current.url = candidate; candidate = null; setPreview(current.url);
      setOriginalShown(true);
    } catch { if (!request.signal.aborted) { if (preview) setOriginalFailed(true); else setPreviewFailed(true); } }
    finally { if (candidate) URL.revokeObjectURL(candidate); if (!request.signal.aborted) setPreviewBusy(false); }
  }
  function cancelPreview() {
    resource.current?.request.abort();
    if (resource.current) resource.current.request = new AbortController();
    setPreviewBusy(false);
  }
  const isImage = file.mediaType.startsWith("image/");
  const imageDescription = !originalShown && inlineImage ? t("channel.attachment.highQualityPreview") : undefined;
  const imageStatus = previewBusy ? t("channel.attachment.loadingOriginalImage")
    : originalFailed ? t("channel.attachment.originalLoadFailed") : imageDescription;
  return <div className="c3-attachment">
    <div className="c3-attachment-file"><Glyph name="save" size={21} />
      <div><Tooltip overflow={{ text: file.name, selector: "strong" }}><strong>{file.name}</strong></Tooltip><small>{fileSize(file.size)}</small></div>
      <ChannelAction icon={download.busy ? "x" : "arrowDown"} label={download.busy ? t("channel.attachment.cancelDownload")
        : isImage ? t("channel.attachment.downloadOriginal") : t("channel.attachment.download")}
        quiet
        onClick={() => { if (download.busy) client.cancelDownload(key); else void client.download(key, file, inlineImage).catch(() => {}); }} />
    </div>
    {isImage && !preview && <ChannelAction icon={previewBusy ? "x" : "eye"} quiet
      label={previewBusy ? t("channel.attachment.cancelImageLoading") : t("channel.attachment.viewImage")}
      onClick={() => { if (previewBusy) cancelPreview(); else void showImage(); }} />}
    {preview && <button type="button" className="c3-attachment-preview" aria-label={t("channel.attachment.openImage", { name: file.name })}
      onClick={() => setImageOpen(true)}><img src={preview} alt={file.name} loading="lazy" decoding="async"
      width={inlineImage?.width} height={inlineImage?.height} onError={() => {
      const current = resource.current;
      if (!current || current.url !== preview) return;
      URL.revokeObjectURL(current.url); current.url = null;
      setPreview(null); setPreviewFailed(true); setImageOpen(false);
    }} /></button>}
    {imageOpen && preview && <ChannelImageDialog src={preview} name={file.name} description={imageStatus}
      original={!originalShown ? { busy: previewBusy, onLoad: () => { void showImage(); }, onCancel: cancelPreview } : undefined}
      onClose={() => { if (previewBusy) cancelPreview(); setImageOpen(false); }} />}
    {(previewFailed || originalFailed || download.error) && <small role="status">{download.error === "file_offer_failed"
      ? t("channel.attachment.fileOfferFailed")
      : download.error ? t("channel.attachment.downloadFailed")
      : originalFailed ? t("channel.attachment.originalUnavailable")
      : t("channel.attachment.previewFailed")}</small>}
  </div>;
}
