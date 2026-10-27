import { useEffect, useRef, useState } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { downloadBlob } from "../../lib/download";
import { type ChannelAttachment as Attachment, type ChannelAttachments, fileSize } from "../attachments";
import { ChannelAction } from "./ChannelMedia";

export function ChannelAttachment({ id, client }: { id: string; client: ChannelAttachments }) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [file, setFile] = useState<Attachment | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const resource = useRef<{ request: AbortController; url: string | null } | null>(null);
  useEffect(() => {
    const current = { request: new AbortController(), url: null as string | null };
    resource.current = current;
    setFile(null); setFailed(false); setBusy(false); setPreview(null);
    void client.metadata(id, current.request.signal).then(value => {
      if (!current.request.signal.aborted) setFile(value);
    }).catch(() => { if (!current.request.signal.aborted) setFailed(true); });
    return () => { current.request.abort(); if (current.url) URL.revokeObjectURL(current.url); };
  }, [id, client, retry]);
  async function open(inline: boolean) {
    const current = resource.current;
    if (!file || !current || busy) return;
    setBusy(true); setFailed(false);
    try {
      const blob = await client.content(id, current.request.signal);
      if (current.request.signal.aborted) return;
      if (inline) {
        if (current.url) URL.revokeObjectURL(current.url);
        current.url = URL.createObjectURL(blob);
        setPreview(current.url);
      } else downloadBlob(blob, file.name);
    } catch { if (!current.request.signal.aborted) setFailed(true); }
    finally { if (!current.request.signal.aborted) setBusy(false); }
  }
  return <div className="c3-attachment">
    <div className="c3-attachment-file"><Glyph name="save" size={21} />
      <div><strong>{file?.name ?? (failed ? (zh ? "附件不可用" : "Attachment unavailable") : (zh ? "正在读取附件" : "Loading attachment"))}</strong>
        {file && <small>{fileSize(file.size)}</small>}</div>
      {file && <ChannelAction icon="arrowDown" label={zh ? "下载" : "Download"} quiet busy={busy} hint="hint-file-download" onClick={() => { void open(false); }} />}
      {!file && failed && <ChannelAction icon="refresh" label={zh ? "重试" : "Retry"} quiet onClick={() => setRetry(value => value + 1)} />}
    </div>
    {file?.mediaType.startsWith("image/") && !preview && <ChannelAction icon="eye" quiet label={zh ? "查看图片" : "View image"}
      busy={busy} onClick={() => { void open(true); }} />}
    {preview && <img src={preview} alt={file?.name ?? ""} />}
    {failed && file && <small role="status">{zh ? "暂时无法读取，请重试。" : "Couldn't load this file. Try again."}</small>}
  </div>;
}
