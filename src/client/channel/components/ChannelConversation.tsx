import { useEffect, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelMessage, ChannelUser } from "../protocol";
import { ChannelAction } from "./ChannelMedia";
import { ChannelAttachment } from "./ChannelAttachment";
import { type AttachmentLimits, type ChannelAttachment as Attachment, type ChannelAttachments, fileSize } from "../attachments";

interface DraftFile { id: string; file: File; uploaded?: Attachment }

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ roomId, roomName, messages, users, canSend, sending, onSend, hidden, attachments, history, loadingHistory, onHistory, onLatest }: {
  roomId: string; roomName: string; messages: ChannelMessage[]; users: ChannelUser[];
  canSend: boolean; sending: boolean; hidden: boolean;
  attachments: ChannelAttachments; history?: { hasMore: boolean; atLatest: boolean }; loadingHistory: boolean;
  onHistory: (roomId: string) => Promise<void>;
  onLatest: (roomId: string) => Promise<void>;
  onSend: (roomId: string, text: string, attachments?: string[]) => Promise<void>;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filesByRoom, setFilesByRoom] = useState<Record<string, DraftFile[]>>({});
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [limitsRetry, setLimitsRetry] = useState(0);
  const [fileError, setFileError] = useState("");
  const [filesBusy, setFilesBusy] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const readingAnchor = useRef<{ room: string; message: string; offset: number } | null>(null);
  const draft = drafts[roomId] ?? "";
  const files = filesByRoom[roomId] ?? [];
  const working = sending || filesBusy;
  useEffect(() => {
    const request = new AbortController();
    setLimitsFailed(false);
    void attachments.limits(request.signal).then(value => { if (!request.signal.aborted) setLimits(value); })
      .catch(() => { if (!request.signal.aborted) setLimitsFailed(true); });
    return () => { request.abort(); };
  }, [attachments, limitsRetry]);
  useEffect(() => () => { upload.current?.abort(); }, []);
  useEffect(() => { setFileError(""); readingAnchor.current = null; }, [roomId]);
  useEffect(() => { follow.current = true; }, [roomId]);
  useEffect(() => { if (history?.atLatest) follow.current = true; }, [history?.atLatest]);
  useEffect(() => {
    const anchor = readingAnchor.current;
    if (anchor?.room === roomId && !loadingHistory && log.current) {
      const node = log.current;
      const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find(element => element.dataset.messageId === anchor.message);
      if (message) node.scrollTop += message.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
      readingAnchor.current = null;
      return;
    }
    if (!hidden && follow.current) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [roomId, messages.length, hidden, loadingHistory, history?.atLatest]);
  function addFiles(incoming: File[]) {
    if (!limits || working || !canSend) return;
    if (files.length + incoming.length > limits.maxAttachmentsPerMessage) {
      setFileError(zh ? `每条消息最多附带 ${limits.maxAttachmentsPerMessage} 个文件。` : `Add up to ${limits.maxAttachmentsPerMessage} files per message.`);
      return;
    }
    if (incoming.some(file => file.size > limits.maxFileBytes)) {
      setFileError(zh ? `单个文件不能超过 ${fileSize(limits.maxFileBytes)}。` : `Each file can be up to ${fileSize(limits.maxFileBytes)}.`);
      return;
    }
    setFileError("");
    setFilesByRoom(previous => ({ ...previous, [roomId]: [...(previous[roomId] ?? []), ...incoming.map(file => ({ id: crypto.randomUUID(), file }))] }));
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if ((!draft.trim() && !files.length) || !canSend || working) return;
    follow.current = true;
    const request = new AbortController();
    upload.current = request;
    setFilesBusy(true); setFileError("");
    try {
      const ids: string[] = [];
      for (const entry of files) {
        const uploaded = entry.uploaded ?? await attachments.upload(roomId, entry.file, request.signal);
        ids.push(uploaded.id);
        setFilesByRoom(previous => ({ ...previous, [roomId]: (previous[roomId] ?? []).map(value => value.id === entry.id ? { ...value, uploaded } : value) }));
      }
      await onSend(roomId, draft.trim(), ids);
      setDrafts(previous => previous[roomId] === draft ? { ...previous, [roomId]: "" } : previous);
      setFilesByRoom(previous => ({ ...previous, [roomId]: (previous[roomId] ?? []).filter(value => !files.some(file => file.id === value.id)) }));
    } catch (error) {
      if (!request.signal.aborted) setFileError(error instanceof Error && error.message === "attachment_store_full"
        ? (zh ? "频道的文件存储已满。" : "The channel's file storage is full.")
        : (zh ? "未能发送，内容已保留，请重试。" : "Couldn't send. Your draft is saved here; try again."));
    } finally { if (upload.current === request) { upload.current = null; setFilesBusy(false); } }
  }
  async function removeFile(entry: DraftFile) {
    if (working) return;
    setFilesBusy(true); setFileError("");
    try {
      if (entry.uploaded) await attachments.discardDraft(entry.uploaded.id);
      setFilesByRoom(previous => ({ ...previous, [roomId]: (previous[roomId] ?? []).filter(value => value.id !== entry.id) }));
    } catch { setFileError(zh ? "未能移除文件，请重试。" : "Couldn't remove the file. Try again."); }
    finally { setFilesBusy(false); }
  }
  return <section id="c3-chat" className="c3-conversation" hidden={hidden} aria-label={zh ? "房间聊天" : "Room chat"}>
    <div className="c3-chat-heading"><Glyph name="chat" size={18} /><strong>{zh ? "聊天" : "Chat"}</strong>
      <span>{roomName}</span></div>
    <div className="c3-message-log" ref={log} role="log" aria-label={zh ? "消息" : "Messages"}
      onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
      {history?.hasMore && <div className="c3-history-more"><ChannelAction icon="arrowUp" quiet label={zh ? "更早的消息" : "Earlier messages"}
        busy={loadingHistory} onClick={() => {
          const node = log.current;
          if (node) {
            const top = node.getBoundingClientRect().top;
            const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
              .find(element => element.getBoundingClientRect().bottom > top);
            readingAnchor.current = message ? { room: roomId, message: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top } : null;
          }
          follow.current = false;
          void onHistory(roomId).catch(() => { readingAnchor.current = null; });
        }} /></div>}
      {!messages.length && <div className="c3-welcome">
        <Glyph name="couch" size={64} />
        <h3>{zh ? "朋友来了，就有话聊。" : "Good company starts here."}</h3>
        <p>{roomId ? (zh ? "打个招呼，或加入语音一起聊。" : "Say hello, or join voice and catch up.")
          : (zh ? "打开邀请链接，进入朋友的频道。" : "Open an invitation to join your friends.")}</p>
      </div>}
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const grouped = previous?.userId === message.userId && message.time - previous.time < 120_000;
        const name = users.find(user => user.id === message.userId)?.name ?? (zh ? "用户" : "User");
        return <article className={`c3-message${grouped ? " is-continuation" : ""}`} key={message.id} data-message-id={message.id}>
          {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} />}
          <div className="c3-message-body">{!grouped && <div className="c3-message-meta"><strong>{name}</strong>
            <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
          </div>}{message.text && <p>{message.text}</p>}
          {message.attachments.map(id => <ChannelAttachment key={id} id={id} client={attachments} />)}</div>
        </article>;
      })}
    </div>
    {history?.atLatest === false && <div className="c3-history-more"><ChannelAction icon="arrowDown" quiet
      label={zh ? "最新消息" : "Latest messages"} busy={loadingHistory} onClick={() => {
        readingAnchor.current = null;
        follow.current = true;
        void onLatest(roomId).catch(() => {});
      }} /></div>}
    {files.length > 0 && <div className="c3-draft-files">{files.map(entry => <div key={entry.id}>
      <Glyph name="save" size={15} /><span>{entry.file.name}</span><small>{fileSize(entry.file.size)}</small>
      <ChannelAction icon="x" iconOnly quiet label={zh ? "移除文件" : "Remove file"} disabled={working} hint="hint-close"
        onClick={() => { void removeFile(entry); }} />
    </div>)}</div>}
    {fileError && <p className="c3-file-error" role="status">{fileError}</p>}
    {limitsFailed && <div className="c3-file-retry"><span>{zh ? "文件服务暂时未连接" : "File service unavailable"}</span>
      <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setLimitsRetry(value => value + 1)} /></div>}
    <form className="c3-composer" onSubmit={event => { void send(event); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
      <input ref={chooser} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
      <ChannelAction icon="plus" label={zh ? "添加文件" : "Add files"} iconOnly quiet hint="hint-file-add"
        disabled={!canSend || working || !limits} onClick={() => chooser.current?.click()} />
      <textarea rows={1} maxLength={2000} aria-label={zh ? "消息内容" : "Message"} value={draft}
        placeholder={zh ? "说点什么…" : "Say something…"} disabled={!roomId}
        onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        onChange={event => setDrafts(previous => ({ ...previous, [roomId]: event.target.value }))}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.currentTarget.form?.requestSubmit();
        } }} />
      <ChannelAction icon="send" label={zh ? "发送" : "Send"} type="submit" primary iconOnly
        disabled={!canSend || (!draft.trim() && !files.length)} busy={working} hint="hint-chat-send" />
    </form>
  </section>;
}
