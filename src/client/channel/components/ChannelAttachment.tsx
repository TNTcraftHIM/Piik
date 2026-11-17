import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelAttachment as Attachment, ImageRendition } from "../protocol";
import { type ChannelAttachments, fileSize } from "../attachments";
import { inlineImageFile } from "../image-preview";
import { ChannelAction } from "./ChannelAction";
import { Tooltip } from "../../components/living/Tooltip";
import { ChannelImageDialog } from "./ChannelImageDialog";
import { channelErrorPresentation } from "../error-presentation";

export function ChannelAttachment({ roomId, messageSeq, file, client, inlineImage }: {
  roomId: string; messageSeq: number; file: Attachment; client: ChannelAttachments; inlineImage?: ImageRendition;
}) {
  const { t } = useCopy();
  const key = { roomId, messageSeq, attachmentId: file.id };
  const downloadSurface = useRef<HTMLDivElement>(null);
  const download = useSyncExternalStore(client.subscribe, () => client.status(key));
  const progress = useSyncExternalStore(client.subscribe, () => client.progress(key));
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [originalShown, setOriginalShown] = useState(false);
  const resource = useRef<{ request: AbortController; url: string | null } | null>(null);
  useEffect(() => {
    const current = { request: new AbortController(), url: null as string | null };
    resource.current = current;
    setPreview(null); setPreviewBusy(false); setPreviewError(null); setImageOpen(false); setOriginalShown(inlineImage?.original ?? false);
    if (inlineImage !== undefined && file.mediaType.startsWith("image/")) {
      try { current.url = URL.createObjectURL(inlineImageFile(inlineImage, file.name)); setPreview(current.url); }
      catch { setPreviewError("image_decode_failed"); }
    }
    return () => { current.request.abort(); if (current.url) URL.revokeObjectURL(current.url); };
  }, [roomId, messageSeq, file.id, client, inlineImage?.data, inlineImage?.mediaType, inlineImage?.original]);
  async function showImage() {
    const current = resource.current;
    if (!current || previewBusy) return;
    setPreviewBusy(true); setPreviewError(null);
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
    } catch (error) { if (!request.signal.aborted) setPreviewError(error instanceof Error ? error.message : "image_load_failed"); }
    finally { if (candidate) URL.revokeObjectURL(candidate); if (!request.signal.aborted) setPreviewBusy(false); }
  }
  function cancelPreview() {
    resource.current?.request.abort();
    if (resource.current) resource.current.request = new AbortController();
    setPreviewBusy(false);
  }
  const isImage = file.mediaType.startsWith("image/");
  const imageDescription = !originalShown && inlineImage ? t("channel.attachment.highQualityPreview") : undefined;
  const previewMessage = channelErrorPresentation(previewError, t, preview ? "channel.attachment.originalUnavailable" : "channel.attachment.previewFailed").message;
  const downloadMessage = channelErrorPresentation(download.error, t, "channel.attachment.downloadFailed").message;
  const progressLabel = progress && t(progress.state === "waiting-source" ? "channel.attachment.waitingSource"
    : progress.state === "waiting" ? "channel.attachment.waitingData" : progress.state === "connecting" ? "channel.attachment.connecting" : progress.state === "finishing"
    ? "channel.attachment.finishing" : "channel.attachment.receiving");
  const progressBytes = progress ? `${fileSize(progress.received)} / ${fileSize(progress.total)}${progress.total > 0 ? ` · ${Math.floor(progress.received / progress.total * 100)}%` : ""}` : null;
  const imageStatus = previewBusy ? progress ? `${progressLabel} · ${progressBytes}` : t("channel.attachment.loadingOriginalImage")
    : previewMessage ?? imageDescription;
  const saving = download.outcome === "started", savedBytes = download.saveProgress;
  return <div className="c3-attachment" ref={downloadSurface}>
    <div className="c3-attachment-file"><Glyph name="save" size={21} />
      <div><Tooltip overflow={{ text: file.name, selector: "strong" }}><strong>{file.name}</strong></Tooltip><small>{fileSize(file.size)}</small></div>
      <ChannelAction icon={download.busy ? "x" : "arrowDown"} label={download.busy ? t("channel.attachment.cancelDownload")
        : isImage ? t("channel.attachment.downloadOriginal") : t("channel.attachment.download")}
        quiet
        onClick={() => { if (download.busy) client.cancelDownload(key); else { setPreviewError(null); void client.download(key, file, inlineImage, downloadSurface.current ?? undefined).catch(() => {}); } }} />
    </div>
    {(download.busy || previewBusy) && progress && <div className="c3-attachment-progress">
      <small role="status">{progressLabel}</small>
      <progress aria-label={progressLabel!} max={progress.total || undefined}
        value={progress.total > 0 && progress.received > 0 ? progress.received : undefined} />
      <small>{progressBytes}</small>
    </div>}
    {saving && <div className="c3-attachment-progress">
      <small role="status">{t("channel.attachment.saving")}</small>
      <progress aria-label={t("channel.attachment.saving")} max={savedBytes?.total || undefined}
        value={savedBytes && savedBytes.total !== null && savedBytes.total > 0 ? savedBytes.received : undefined} />
      {savedBytes && <small>{fileSize(savedBytes.received)}{savedBytes.total !== null && ` / ${fileSize(savedBytes.total)}`}
        {savedBytes.total !== null && savedBytes.total > 0 && ` · ${Math.floor(savedBytes.received / savedBytes.total * 100)}%`}</small>}
    </div>}
    {!download.busy && (download.outcome === "requested" || download.outcome === "dispatched" || download.outcome === "saved") && <small role="status">{t(download.outcome === "saved"
      ? "channel.attachment.saved"
      : download.outcome === "requested" ? "channel.attachment.downloadRequested" : "channel.attachment.downloadSent")}</small>}
    {isImage && !preview && <ChannelAction icon={previewBusy ? "x" : "eye"} quiet
      label={previewBusy ? t("channel.attachment.cancelImageLoading") : t("channel.attachment.viewImage")}
      onClick={() => { if (previewBusy) cancelPreview(); else void showImage(); }} />}
    {preview && <button type="button" className="c3-attachment-preview" aria-label={t("channel.attachment.openImage", { name: file.name })}
      onClick={() => setImageOpen(true)}><img src={preview} alt={file.name} loading="lazy" decoding="async"
      width={inlineImage?.width} height={inlineImage?.height} onError={() => {
      const current = resource.current;
      if (!current || current.url !== preview) return;
      URL.revokeObjectURL(current.url); current.url = null;
      setPreview(null); setPreviewError("image_decode_failed"); setImageOpen(false);
    }} /></button>}
    {imageOpen && preview && <ChannelImageDialog src={preview} name={file.name} description={imageStatus}
      original={!originalShown ? { busy: previewBusy, onLoad: () => { void showImage(); }, onCancel: cancelPreview } : undefined}
      onClose={() => { if (previewBusy) cancelPreview(); setImageOpen(false); }} />}
    {(downloadMessage || previewMessage) && <small role="status">{downloadMessage ?? previewMessage}</small>}
  </div>;
}
