import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Glyph } from "../../ui/icons";
import { joinItems, useCopy } from "../../ui/copy";
import type { ChannelAttachment as Attachment, ImageRendition } from "../protocol";
import { attachmentDownloadDocument, type ChannelAttachments, fileSize, isNativeSavePending } from "../attachments";
import { inlineImageFile } from "../image-preview";
import { ChannelAction } from "./ChannelAction";
import { Tooltip } from "../../components/living/Tooltip";
import { ChannelImageDialog } from "./ChannelImageDialog";
import { channelErrorPresentation } from "../error-presentation";
import { useSurfaceDocument } from "../../ui/panel-window";

const visibilityObservers = new WeakMap<Document, {
  observer: IntersectionObserver;
  callbacks: Map<Element, (visible: boolean) => void>;
}>();

function observeCard(element: Element, onVisibility: (visible: boolean) => void) {
  const doc = element.ownerDocument;
  const Observer = doc.defaultView?.IntersectionObserver;
  if (!Observer) return;
  let visibility = visibilityObservers.get(doc);
  if (!visibility) {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    const observer = new Observer(entries => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    });
    visibility = { observer, callbacks };
    visibilityObservers.set(doc, visibility);
  }
  const { observer, callbacks } = visibility;
  callbacks.set(element, onVisibility);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    callbacks.delete(element);
    if (!callbacks.size) { observer.disconnect(); visibilityObservers.delete(doc); }
  };
}

function TransferProgress({ label, accessibleLabel, bytes }: { label: string; accessibleLabel: string; bytes?: { received: number; total: number | null } | null }) {
  const total = bytes?.total || undefined;
  return <div className="c3-attachment-progress">
    <div>
      <small role="status">{label}</small>
      {total && bytes ? <small>{Math.floor(bytes.received / total * 100)}%</small> : null}
    </div>
    <progress aria-label={accessibleLabel} max={total} value={total ? bytes?.received : undefined} />
    {bytes && <small>{fileSize(bytes.received)}{bytes.total !== null && ` / ${fileSize(bytes.total)}`}</small>}
  </div>;
}

export function ChannelAttachment({ roomId, messageSeq, file, client, inlineImage }: {
  roomId: string; messageSeq: number; file: Attachment; client: ChannelAttachments; inlineImage?: ImageRendition;
}) {
  const { lang, t } = useCopy();
  const labelForFile = (label: string) => joinItems(lang, [label, file.name]);
  const key = { roomId, messageSeq, attachmentId: file.id };
  const downloadSurface = useRef<HTMLDivElement>(null);
  const surfaceDocument = useSurfaceDocument();
  const downloadStatus = () => client.status(key);
  const savedStatus = () => client.hasSavedCopy(key, file);
  const originalStatusSnapshot = () => client.originalAvailability(key, file, inlineImage?.original === true);
  const transferProgress = () => client.progress(key);
  const download = useSyncExternalStore(client.subscribe, downloadStatus, downloadStatus);
  const savedCopy = useSyncExternalStore(client.subscribe, savedStatus, savedStatus);
  const availability = useSyncExternalStore(client.subscribe, originalStatusSnapshot, originalStatusSnapshot);
  const unavailable = availability === false;
  const [revealing, setRevealing] = useState(false);
  const progress = useSyncExternalStore(client.subscribe, transferProgress, transferProgress);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  useEffect(() => {
    setCardVisible(false);
    const element = downloadSurface.current;
    if (element) return observeCard(element, setCardVisible);
  }, [surfaceDocument]);
  const observing = cardVisible || imageOpen;
  useEffect(() => {
    if (observing) return client.observe({ roomId, messageSeq, attachmentId: file.id });
  }, [observing, client, roomId, messageSeq, file.id]);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const dialogUrl = originalUrl ?? preview;
  const originalShown = !!originalUrl || inlineImage?.original === true;
  const resource = useRef<{ request: AbortController; url: string | null } | null>(null);
  useEffect(() => {
    const current = { request: new AbortController(), url: null as string | null };
    resource.current = current;
    setPreview(null); setPreviewBusy(false); setPreviewError(null); setImageOpen(false); setOriginalUrl(null);
    if (inlineImage !== undefined && file.mediaType.startsWith("image/")) {
      try { current.url = URL.createObjectURL(inlineImageFile(inlineImage, file.name)); setPreview(current.url); }
      catch { setPreviewError("image_decode_failed"); }
    }
    return () => {
      current.request.abort();
      if (current.url) URL.revokeObjectURL(current.url);
    };
  }, [roomId, messageSeq, file.id, client, inlineImage?.data, inlineImage?.mediaType, inlineImage?.original]);
  async function showImage() {
    const current = resource.current;
    if (!current || previewBusy) return;
    setPreviewBusy(true); setPreviewError(null);
    const request = current.request;
    try {
      const verified = await client.content(key, file, request.signal, inlineImage);
      if (request.signal.aborted) return;
      const image = new Image();
      const candidate = URL.createObjectURL(verified);
      const discard = () => {
        image.removeAttribute("src");
        URL.revokeObjectURL(candidate);
      };
      request.signal.addEventListener("abort", discard, { once: true });
      try {
        image.src = candidate;
        await image.decode();
      } catch (error) {
        if (!request.signal.aborted) discard();
        throw error;
      } finally { request.signal.removeEventListener("abort", discard); }
      if (request.signal.aborted) return;
      request.signal.addEventListener("abort", () => URL.revokeObjectURL(candidate), { once: true });
      setOriginalUrl(candidate); setImageOpen(true);
    } catch (error) { if (!request.signal.aborted) setPreviewError(error instanceof Error ? error.message : "image_load_failed"); }
    finally { if (!request.signal.aborted) setPreviewBusy(false); }
  }
  function cancelPreview() {
    resource.current?.request.abort();
    if (resource.current) resource.current.request = new AbortController();
    setOriginalUrl(null);
    setPreviewBusy(false);
  }
  const isImage = file.mediaType.startsWith("image/");
  const imageDescription = !originalShown && inlineImage ? t("channel.attachment.thumbnail") : undefined;
  const originalStatus = unavailable ? t("channel.attachment.sourceUnavailable") : undefined;
  const previewMessage = channelErrorPresentation(previewError, t, preview ? "channel.attachment.originalUnavailable" : "channel.attachment.previewFailed").message;
  const downloadError = availability === true && download.error === "file_source_unavailable" ? null : download.error;
  const downloadMessage = channelErrorPresentation(downloadError, t, "channel.attachment.downloadFailed").message;
  const progressLabel = progress ? t(progress.state === "waiting-source" ? "channel.attachment.waitingSource"
    : progress.state === "waiting" ? "channel.attachment.waitingData" : progress.state === "connecting" ? "channel.attachment.connecting" : progress.state === "finishing"
    ? "channel.attachment.finishing" : "channel.attachment.receiving")
    : t(previewBusy ? "channel.attachment.loadingOriginalImage" : "channel.attachment.waitingData");
  const progressBytes = progress && (progress.received > 0 || progress.state === "receiving" || progress.state === "finishing") ? progress : null;
  const imageStatus = [...new Set([previewMessage, !originalShown ? originalStatus : undefined].filter(Boolean))].join(" ") || imageDescription;
  const saving = download.outcome === "started", savedBytes = download.saveProgress;
  const savePending = isNativeSavePending(download.outcome);
  const saved = savedCopy || download.outcome === "saved";
  const canReveal = savedCopy && typeof attachmentDownloadDocument(surfaceDocument)?.defaultView?.piikRevealDownload === "function";
  const canRetryDownload = !unavailable && downloadError &&
    !["file_offer_failed", "reveal_saved_copy_failed", "saved_copy_missing"].includes(downloadError);
  const downloadLabel = download.busy ? t("channel.attachment.cancelDownload")
    : savePending ? t(saving ? "channel.attachment.saving" : "channel.attachment.downloadRequested")
    : canReveal ? t("channel.attachment.revealSaved")
    : canRetryDownload ? t("common.retry")
    : t(isImage ? "channel.attachment.downloadOriginal" : "channel.attachment.download");
  const imageLabel = t(previewBusy ? "channel.attachment.cancelImageLoading" : "channel.attachment.viewImage");
  const saveLabel = t("channel.attachment.saving");
  const downloadNotice = download.outcome === "requested" ? t("channel.attachment.downloadRequested")
    : download.outcome === "dispatched" ? t("channel.attachment.downloadSent")
    : download.outcome === "unconfirmed" ? t("channel.attachment.downloadUnconfirmed")
    : download.outcome === "cancelled" ? t("channel.attachment.downloadCancelled") : undefined;
  const originalNotice = !imageOpen && !download.busy && !previewBusy && !savePending && (isImage || !canReveal)
    ? originalStatus : undefined;
  const cardStatus = [...new Set([downloadMessage, !imageOpen ? previewMessage : undefined, originalNotice].filter(Boolean))].join(" ");
  return <div className="c3-attachment" ref={downloadSurface}>
    <div className="c3-attachment-file"><Glyph name={saved ? "check" : "fileDown"} size={21} />
      <div><Tooltip overflow={{ text: file.name, selector: "strong" }}><strong>{file.name}</strong></Tooltip><small>{fileSize(file.size)}</small></div>
      <ChannelAction icon={download.busy ? "x" : canReveal ? "folder" : canRetryDownload ? "refresh" : "arrowDown"}
        label={downloadLabel} accessibleLabel={labelForFile(downloadLabel)}
        quiet iconOnly={savePending} busy={savePending || (revealing && !download.busy)}
        disabled={unavailable && !download.busy && !savePending && !canReveal}
        onClick={() => {
          if (download.busy) { client.cancelDownload(key); return; }
          const surface = downloadSurface.current;
          if (canReveal && surface) {
            setRevealing(true);
            void client.revealSavedCopy(key, file, surface).catch(() => {}).finally(() => setRevealing(false));
            return;
          }
          void client.download(key, file, inlineImage, surface ?? undefined).catch(() => {});
        }} />
    </div>
    {(download.busy || (previewBusy && !imageOpen)) && <TransferProgress label={progressLabel} accessibleLabel={labelForFile(progressLabel)} bytes={progressBytes} />}
    {saving && <TransferProgress label={saveLabel} accessibleLabel={labelForFile(saveLabel)} bytes={savedBytes} />}
    {!download.busy && !savePending && saved && <small className="c3-attachment-saved" role="status">{t("channel.attachment.saved")}</small>}
    {!download.busy && downloadNotice && <small role="status">{downloadNotice}</small>}
    {isImage && !preview && <ChannelAction icon={previewBusy ? "x" : "eye"} quiet
      disabled={unavailable && !previewBusy}
      label={imageLabel} accessibleLabel={labelForFile(imageLabel)}
      onClick={() => { if (previewBusy) cancelPreview(); else void showImage(); }} />}
    {preview && <button type="button" className="c3-attachment-preview" aria-label={t("channel.attachment.openImage", { name: file.name })}
      onClick={() => setImageOpen(true)}><img src={preview} alt={file.name} loading="lazy" decoding="async"
      width={inlineImage?.width} height={inlineImage?.height} onError={() => {
      const current = resource.current;
      if (!current || current.url !== preview) return;
      URL.revokeObjectURL(current.url); current.url = null;
      setPreview(null); setPreviewError("image_decode_failed"); if (!originalUrl) setImageOpen(false);
    }} /></button>}
    {imageOpen && dialogUrl && <ChannelImageDialog src={dialogUrl} name={file.name} description={previewBusy ? undefined : imageStatus}
      progress={previewBusy ? <TransferProgress label={progressLabel} accessibleLabel={labelForFile(progressLabel)} bytes={progressBytes} /> : undefined}
      original={!originalShown ? { busy: previewBusy, disabled: unavailable, onLoad: () => { void showImage(); }, onCancel: cancelPreview } : undefined}
      onClose={() => { cancelPreview(); setImageOpen(false); }} />}
    {cardStatus && <small role="status">{cardStatus}</small>}
  </div>;
}
