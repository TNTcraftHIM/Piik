import { useEffect, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelMessage, ChannelUser } from "../protocol";
import { ChannelAction } from "./ChannelMedia";
import { ChannelAttachment } from "./ChannelAttachment";
import { type AttachmentLimits, type DraftFile, type ChannelAttachments, fileSize } from "../attachments";
import { ChannelRoomStart, type ChannelEntry } from "./ChannelRoomStart";
import "./channel-conversation.css";

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ roomId, roomName, entry, messages, users, canSend, sending, onSend, hidden, attachments, attachmentsAvailable = true, available, history, loadingHistory, onHistory, onLatest }: {
  roomId: string; roomName: string; messages: ChannelMessage[]; users: ChannelUser[];
  entry?: ChannelEntry;
  canSend: boolean; sending: boolean; hidden: boolean; available: boolean;
  attachments: ChannelAttachments; attachmentsAvailable?: boolean; history?: { hasMore: boolean; atLatest: boolean }; loadingHistory: boolean;
  onHistory: (roomId: string) => Promise<void>;
  onLatest: (roomId: string) => Promise<void>;
  onSend: (roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal) => Promise<void>;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filesByRoom, setFilesByRoom] = useState<Record<string, DraftFile[]>>({});
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [limitsRetry, setLimitsRetry] = useState(0);
  const [fileError, setFileError] = useState("");
  const preparing = useRef<AbortController | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const readingAnchor = useRef<{ room: string; message: string; offset: number } | null>(null);
  const draft = drafts[roomId] ?? "";
  const files = filesByRoom[roomId] ?? [];
  const working = sending;
  useEffect(() => {
    if (!attachmentsAvailable) { setLimits(null); setLimitsFailed(false); return; }
    const request = new AbortController();
    setLimitsFailed(false);
    void attachments.limits(request.signal).then(value => { if (!request.signal.aborted) setLimits(value); })
      .catch(() => { if (!request.signal.aborted) setLimitsFailed(true); });
    return () => { request.abort(); };
  }, [attachments, attachmentsAvailable, limitsRetry]);
  useEffect(() => () => { preparing.current?.abort(); }, []);
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
    if (!attachmentsAvailable || !limits || working || !canSend) return;
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
    preparing.current = request;
    setFileError("");
    try {
      await onSend(roomId, draft.trim(), files, request.signal);
      setDrafts(previous => previous[roomId] === draft ? { ...previous, [roomId]: "" } : previous);
      setFilesByRoom(previous => ({ ...previous, [roomId]: (previous[roomId] ?? []).filter(value => !files.some(file => file.id === value.id)) }));
    } catch (error) {
      if (!request.signal.aborted) setFileError(zh ? "未能发送，内容已保留，请重试。" : "Couldn't send. Your draft is saved here; try again.");
    } finally { if (preparing.current === request) preparing.current = null; }
  }
  function removeFile(entry: DraftFile) {
    if (working) return;
    setFileError("");
    setFilesByRoom(previous => ({ ...previous, [roomId]: (previous[roomId] ?? []).filter(value => value.id !== entry.id) }));
  }
  return <section id="c3-chat" className="c3-conversation" hidden={hidden} aria-label={zh ? "房间聊天" : "Room chat"}>
    <div className="c3-chat-heading"><Glyph name="chat" size={18} /><strong>{zh ? "聊天" : "Chat"}</strong>
      <span>{roomName}</span></div>
    <div className="c3-message-log" ref={log} role="log" aria-label={zh ? "消息" : "Messages"}
      onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
      {history?.hasMore && <div className="c3-history-more"><ChannelAction icon="arrowUp" quiet label={zh ? "更早的消息" : "Earlier messages"}
        busy={loadingHistory} disabled={!available} onClick={() => {
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
      {!history?.hasMore && <ChannelRoomStart roomName={roomName}
        entry={!roomId ? entry ?? { kind: "entry" } : undefined} empty={!messages.length} />}
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const grouped = previous?.userId === message.userId && message.time - previous.time < 120_000;
        const name = users.find(user => user.id === message.userId)?.name ?? (zh ? "用户" : "User");
        return <article className={`c3-message${grouped ? " is-continuation" : ""}`} key={message.id} data-message-id={message.id}>
          {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} />}
          <div className="c3-message-body">{!grouped && <div className="c3-message-meta"><strong>{name}</strong>
            <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
          </div>}{message.text && <p>{message.text}</p>}
          {message.attachments.map(file => <ChannelAttachment key={file.id} roomId={roomId} messageSeq={message.seq} file={file} client={attachments} />)}</div>
        </article>;
      })}
    </div>
    {history?.atLatest === false && <div className="c3-history-more"><ChannelAction icon="arrowDown" quiet
      label={zh ? "最新消息" : "Latest messages"} busy={loadingHistory} disabled={!available} onClick={() => {
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
    {limitsFailed && <div className="c3-file-retry"><span>{zh ? "文件处理暂不可用" : "File preparation unavailable"}</span>
      <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setLimitsRetry(value => value + 1)} /></div>}
    {roomId && <form className="c3-composer" onSubmit={event => { void send(event); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
      {attachmentsAvailable && <><input ref={chooser} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
        <ChannelAction icon="plus" label={zh ? "添加文件" : "Add files"} iconOnly quiet hint="hint-file-add"
          disabled={!canSend || working || !limits} onClick={() => chooser.current?.click()} /></>}
      <textarea rows={1} maxLength={2000} aria-label={zh ? "消息内容" : "Message"} value={draft}
        placeholder={zh ? "说点什么…" : "Say something…"} disabled={!roomId}
        onPaste={event => { if (attachmentsAvailable && event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        onChange={event => setDrafts(previous => ({ ...previous, [roomId]: event.target.value }))}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.currentTarget.form?.requestSubmit();
        } }} />
      <ChannelAction icon="send" label={zh ? "发送" : "Send"} type="submit" primary iconOnly
        disabled={!canSend || (!draft.trim() && !files.length)} busy={working} hint="hint-chat-send" />
    </form>}
  </section>;
}
