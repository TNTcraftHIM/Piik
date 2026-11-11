import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelAttachment as Attachment } from "../protocol";
import { type ChannelAttachments, fileSize } from "../attachments";
import { ChannelAction } from "./ChannelAction";
import { Tooltip } from "../../components/living/Tooltip";
import { ChannelImageDialog } from "./ChannelImageDialog";

export function ChannelAttachment({ roomId, messageSeq, file, client, inlineImage }: {
  roomId: string; messageSeq: number; file: Attachment; client: ChannelAttachments; inlineImage?: string;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const key = { roomId, messageSeq, attachmentId: file.id };
  const download = useSyncExternalStore(client.subscribe, () => client.status(key));
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const resource = useRef<{ request: AbortController; url: string | null } | null>(null);
  useEffect(() => {
    const current = { request: new AbortController(), url: null as string | null };
    resource.current = current;
    setPreview(null); setPreviewBusy(false); setPreviewFailed(false); setImageOpen(false);
    if (inlineImage !== undefined && file.mediaType.startsWith("image/")) {
      void client.content({ roomId, messageSeq, attachmentId: file.id }, file, current.request.signal, inlineImage).then(readable => {
        if (current.request.signal.aborted) return;
        current.url = URL.createObjectURL(readable); setPreview(current.url);
      }).catch(() => { if (!current.request.signal.aborted) setPreviewFailed(true); });
    }
    return () => { current.request.abort(); if (current.url) URL.revokeObjectURL(current.url); };
  }, [roomId, messageSeq, file.id, client, inlineImage]);
  async function showImage() {
    const current = resource.current;
    if (!current || previewBusy) return;
    setPreviewBusy(true); setPreviewFailed(false);
    try {
      const verified = await client.content(key, file, current.request.signal, inlineImage);
      if (current.request.signal.aborted) return;
      current.url = URL.createObjectURL(verified); setPreview(current.url);
    } catch { if (!current.request.signal.aborted) setPreviewFailed(true); }
    finally { if (!current.request.signal.aborted) setPreviewBusy(false); }
  }
  return <div className="c3-attachment">
    <div className="c3-attachment-file"><Glyph name="save" size={21} />
      <div><Tooltip overflow={{ text: file.name, selector: "strong" }}><strong>{file.name}</strong></Tooltip><small>{fileSize(file.size)}</small></div>
      <ChannelAction icon={download.busy ? "x" : "arrowDown"} label={download.busy ? (zh ? "取消下载" : "Cancel download") : (zh ? "下载" : "Download")}
        quiet hint={download.busy ? "hint-close" : "hint-file-download"}
        onClick={() => { if (download.busy) client.cancelDownload(key); else void client.download(key, file, inlineImage).catch(() => {}); }} />
    </div>
    {file.mediaType.startsWith("image/") && !preview && <ChannelAction icon="eye" quiet label={zh ? "查看图片" : "View image"}
      busy={previewBusy} onClick={() => { void showImage(); }} />}
    {preview && <button type="button" className="c3-attachment-preview" aria-label={zh ? `打开图片 ${file.name}` : `Open image ${file.name}`}
      onClick={() => setImageOpen(true)}><img src={preview} alt={file.name} loading="lazy" decoding="async" onError={() => {
      const current = resource.current;
      if (!current || current.url !== preview) return;
      URL.revokeObjectURL(current.url); current.url = null;
      setPreview(null); setPreviewFailed(true); setImageOpen(false);
    }} /></button>}
    {imageOpen && preview && <ChannelImageDialog src={preview} name={file.name} onClose={() => setImageOpen(false)} />}
    {(previewFailed || download.error) && <small role="status">{download.error === "file_offer_failed"
      ? (zh ? "消息已保存，文件暂时无法分享。" : "Message saved. The file could not be offered yet.")
      : download.error ? (zh ? "暂时无法读取，请重试。" : "Couldn't load this file. Try again.")
      : (zh ? "图片预览失败，可重试或下载原文件。" : "Couldn't preview this image. Retry or download the file.")}</small>}
  </div>;
}
