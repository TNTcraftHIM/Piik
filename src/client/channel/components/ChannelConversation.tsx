import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelMessage, ChannelUser } from "../protocol";
import { ChannelAction } from "./ChannelMedia";
import { ChannelAttachment } from "./ChannelAttachment";
import { type AttachmentLimits, type DraftFile, type ChannelAttachments, fileSize } from "../attachments";
import { ChannelRoomStart, type ChannelEntry } from "./ChannelRoomStart";
import { ChannelMessageReactions } from "./ChannelMessageReactions";
import type { ReactionId } from "../../../shared/room-interactions";
import { useSurfaceDocument } from "../../ui/panel-window";
import "./channel-conversation.css";

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ roomId, roomName, roomIcon, entry, messages, users, selfUserId, canSend, sending, onSend, hidden, floating = false, attachments, attachmentsAvailable = true, available, history, loadingHistory, onHistory, onLatest, isReactionPending, onReaction }: {
  roomId: string; roomName: string; roomIcon?: string; messages: ChannelMessage[]; users: ChannelUser[];
  entry?: ChannelEntry;
  selfUserId: string | null;
  canSend: boolean; sending: boolean; hidden: boolean; available: boolean;
  floating?: boolean;
  attachments: ChannelAttachments; attachmentsAvailable?: boolean; history?: { hasMore: boolean; atLatest: boolean }; loadingHistory: boolean;
  onHistory: (roomId: string) => Promise<void>;
  onLatest: (roomId: string) => Promise<void>;
  onSend: (roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal) => Promise<void>;
  isReactionPending: (messageSeq: number) => boolean;
  onReaction: (roomId: string, messageSeq: number, reaction: ReactionId, active: boolean) => Promise<void>;
}) {
  const { lang } = useCopy();
  const surfaceDocument = useSurfaceDocument();
  const zh = lang === "zh";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filesByRoom, setFilesByRoom] = useState<Record<string, DraftFile[]>>({});
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [limitsRetry, setLimitsRetry] = useState(0);
  const [fileErrorsByRoom, setFileErrorsByRoom] = useState<Record<string, string>>({});
  const preparing = useRef<AbortController | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const reading = useRef({ position: 0, following: true });
  const readingAnchor = useRef<{ room: string; message: string; offset: number } | null>(null);
  const draft = drafts[roomId] ?? "";
  const files = filesByRoom[roomId] ?? [];
  const fileError = fileErrorsByRoom[roomId] ?? "";
  const setFileError = (error: string) => setFileErrorsByRoom(previous => ({ ...previous, [roomId]: error }));
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
  useLayoutEffect(() => { readingAnchor.current = null; reading.current = { position: 0, following: true }; }, [roomId]);
  useLayoutEffect(() => { if (history?.atLatest) reading.current.following = true; }, [history?.atLatest]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (anchor?.room === roomId && !loadingHistory && log.current) {
      const node = log.current;
      const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find(element => element.dataset.messageId === anchor.message);
      if (message) node.scrollTop += message.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
      readingAnchor.current = null;
      return;
    }
    const node = log.current;
    if (hidden || !node) return;
    const saved = reading.current;
    const restore = () => { node.scrollTop = saved.following ? (messages.length ? node.scrollHeight : 0) : saved.position; };
    restore();
    const view = node.ownerDocument.defaultView;
    const frame = view?.requestAnimationFrame(restore);
    return () => { if (frame !== undefined) view?.cancelAnimationFrame(frame); };
  }, [roomId, messages.length, hidden, loadingHistory, history?.atLatest, floating, surfaceDocument]);
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
    reading.current.following = true;
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
      onScroll={event => { const node = event.currentTarget; reading.current = { position: node.scrollTop, following: node.scrollHeight - node.scrollTop - node.clientHeight < 60 }; }}>
      {history?.hasMore && <div className="c3-history-more"><ChannelAction icon="arrowUp" quiet label={zh ? "更早的消息" : "Earlier messages"}
        busy={loadingHistory} disabled={!available} onClick={() => {
          const node = log.current;
          if (node) {
            const top = node.getBoundingClientRect().top;
            const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
              .find(element => element.getBoundingClientRect().bottom > top);
            readingAnchor.current = message ? { room: roomId, message: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top } : null;
          }
          reading.current.following = false;
          void onHistory(roomId).catch(() => { readingAnchor.current = null; });
        }} /></div>}
      {!history?.hasMore && <ChannelRoomStart roomName={roomName} icon={roomIcon} canSend={canSend}
        entry={!roomId ? entry ?? { kind: "entry" } : undefined}
        empty={!messages.length && (!roomId || (!!history && !loadingHistory))} />}
      {roomId && loadingHistory && !messages.length && <div className="c3-conversation-loading" role="status">
        <Glyph name="loader" className="lr-spin" size={18} /><span>{zh ? "正在加载消息…" : "Loading messages…"}</span>
      </div>}
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const grouped = previous?.userId === message.userId && message.time - previous.time < 120_000;
        const name = users.find(user => user.id === message.userId)?.name ?? (zh ? "用户" : "User");
        return <article className={`c3-message c3-reaction-message${grouped ? " is-continuation" : ""}`} key={message.id} data-message-id={message.id}>
          {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} />}
          <div className="c3-message-body">{!grouped && <div className="c3-message-meta"><strong>{name}</strong>
            <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
          </div>}{message.text && <p>{message.text}</p>}
          {message.attachments.map(file => <ChannelAttachment key={file.id} roomId={roomId} messageSeq={message.seq} file={file} client={attachments} />)}
          <ChannelMessageReactions reactions={message.reactions} selfUserId={selfUserId} pending={isReactionPending(message.seq)}
            disabled={!available} onSet={(reaction, active) => { void onReaction(roomId, message.seq, reaction, active).catch(() => {}); }} /></div>
        </article>;
      })}
    </div>
    {history?.atLatest === false && <div className="c3-history-more"><ChannelAction icon="arrowDown" quiet
      label={zh ? "最新消息" : "Latest messages"} busy={loadingHistory} disabled={!available} onClick={() => {
        readingAnchor.current = null;
        reading.current.following = true;
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
