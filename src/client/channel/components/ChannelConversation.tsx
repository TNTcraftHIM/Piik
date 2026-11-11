import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { MAX_MESSAGE_CODE_POINTS, type ChannelMessage, type ChannelUser } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { messageAuthorName } from "../presentation";
import { ChannelAttachment } from "./ChannelAttachment";
import { type AttachmentLimits, type DraftFile, type ChannelAttachments, fileSize } from "../attachments";
import { ChannelRoomStart, type ChannelEntry } from "./ChannelRoomStart";
import { ChannelContentReactions } from "./ChannelContentReactions";
import { BackButton } from "../../components/living/primitives";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { useSurfaceDocument } from "../../ui/panel-window";
import { Tooltip } from "../../components/living/Tooltip";
import type { ChatOptions } from "../types";
import { loadRoomHosting } from "../hosting";
import { ChannelMentionSuggestions, editMentions, matchingMentionUsers, mentionQuery } from "./ChannelMentionSuggestions";
import "./channel-conversation.css";

type Draft = { text: string; mentions: NonNullable<ChatOptions["mentions"]>; reply?: { seq: number; notify: boolean; name: string; text: string } };
const emptyDraft: Draft = { text: "", mentions: [] };

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ roomId, roomName, roomIcon, entry, messages, users, selfUserId, canSend, sending, onSend, hidden, floating = false, attachments, attachmentsAvailable = true, available, history, loadingHistory, onHistory, onLatest, onMessage, unreadAfter, onRead, interaction, onBack }: {
  roomId: string; roomName: string; roomIcon?: string; messages: ChannelMessage[]; users: ChannelUser[];
  entry?: ChannelEntry;
  selfUserId?: string | null;
  canSend: boolean; sending: boolean; hidden: boolean; available: boolean;
  floating?: boolean;
  attachments: ChannelAttachments; attachmentsAvailable?: boolean; history?: { hasMore: boolean; atLatest: boolean }; loadingHistory: boolean;
  onHistory: (roomId: string) => Promise<void>;
  onLatest: (roomId: string) => Promise<void>;
  onSend: (roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal, options?: ChatOptions) => Promise<void>;
  onMessage?: (roomId: string, seq: number) => Promise<void>;
  unreadAfter?: number; onRead?: (roomId: string, seq: number) => void;
  interaction: RoomInteractionSession | null;
  onBack?: () => void;
}) {
  const { lang } = useCopy();
  const surfaceDocument = useSurfaceDocument();
  const zh = lang === "zh";
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionId = useId();
  const [jump, setJump] = useState<{ room: string; seq: number } | null>(null);
  const jumpRequest = useRef<object | null>(null);
  const [jumpFailed, setJumpFailed] = useState(false);
  const [unreadBoundary, setUnreadBoundary] = useState({ room: roomId, after: unreadAfter });
  // Capture a visit's divider before markRead advances the durable personal cursor.
  useLayoutEffect(() => {
    setUnreadBoundary(previous => previous.room !== roomId
      || (!hidden && unreadAfter !== undefined && unreadAfter < (messages.at(-1)?.seq ?? 0))
      ? { room: roomId, after: unreadAfter } : previous);
  }, [roomId, hidden]);
  const [filesByRoom, setFilesByRoom] = useState<Record<string, DraftFile[]>>({});
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [mentionLimit, setMentionLimit] = useState<number | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [limitsRetry, setLimitsRetry] = useState(0);
  const [fileErrorsByRoom, setFileErrorsByRoom] = useState<Record<string, string>>({});
  const preparing = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const chooser = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reading = useRef({ position: 0, following: true });
  const readingAnchor = useRef<{ room: string; message: string; offset: number } | null>(null);
  let authorMessageId = "";
  const draft = drafts[roomId] ?? emptyDraft;
  const text = draft.text.trim();
  const query = selection && !composing.current && mentionLimit !== null && draft.mentions.length < mentionLimit
    && !draft.mentions.some(mention => selection.start > mention.start && selection.start <= mention.end)
    ? mentionQuery(draft.text, selection.start, selection.end) : null;
  const candidates = query ? matchingMentionUsers(users, query.query) : [];
  const activeMention = Math.min(mentionIndex, candidates.length - 1);
  const textLength = Array.from(text).length;
  const textTooLong = textLength > MAX_MESSAGE_CODE_POINTS;
  const textErrorId = useId();
  const files = filesByRoom[roomId] ?? [];
  const fileError = fileErrorsByRoom[roomId] ?? "";
  const setFileError = (error: string) => setFileErrorsByRoom(previous => ({ ...previous, [roomId]: error }));
  const working = sending;
  function updateDraft(update: (previous: Draft) => Draft) {
    setDrafts(previous => ({ ...previous, [roomId]: update(previous[roomId] ?? emptyDraft) }));
  }
  function selectMention(user: ChannelUser) {
    if (!query) return;
    const inserted = `@${user.name} `;
    const next = draft.text.slice(0, query.start) + inserted + draft.text.slice(query.end);
    updateDraft(previous => ({ ...previous, text: next,
      mentions: [...editMentions(previous.text, next, previous.mentions), { userId: user.id, start: query.start, end: query.start + inserted.length - 1 }].sort((a, b) => a.start - b.start) }));
    const caret = query.start + inserted.length;
    setSelection(null);
    input.current?.focus();
    surfaceDocument?.defaultView?.requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  }
  function readVisible() {
    const node = log.current, doc = node?.ownerDocument;
    if (!hidden && roomId && available && !loadingHistory && history?.atLatest && node?.getClientRects().length
      && doc?.visibilityState === "visible" && doc.hasFocus() && node.scrollHeight - node.scrollTop - node.clientHeight < 4) {
      const seq = messages.at(-1)?.seq;
      if (seq !== undefined) onRead?.(roomId, seq);
    }
  }
  useEffect(() => {
    const doc = surfaceDocument, view = doc?.defaultView;
    const frame = view?.requestAnimationFrame(readVisible);
    doc?.addEventListener("visibilitychange", readVisible);
    view?.addEventListener("focus", readVisible);
    return () => { if (frame !== undefined) view?.cancelAnimationFrame(frame); doc?.removeEventListener("visibilitychange", readVisible); view?.removeEventListener("focus", readVisible); };
  }, [roomId, messages, hidden, available, loadingHistory, history?.atLatest, surfaceDocument, onRead]);
  useLayoutEffect(() => {
    if (!jump || jump.room !== roomId || loadingHistory) return;
    const target = log.current?.querySelector<HTMLElement>(`[data-message-seq="${jump.seq}"]`);
    if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); reading.current = { position: log.current!.scrollTop, following: false }; setJump(null); }
  }, [jump, roomId, loadingHistory, messages]);
  useLayoutEffect(() => { setSelection(null); setJump(null); jumpRequest.current = null; setJumpFailed(false); }, [roomId]);
  async function showMessage(seq: number) {
    setJumpFailed(false); readingAnchor.current = null; reading.current.following = false;
    const request = { room: roomId, seq };
    jumpRequest.current = request; setJump(request);
    if (messages.some(message => message.seq === seq)) return;
    try { if (!onMessage) throw new Error("unavailable"); await onMessage(roomId, seq); }
    catch { if (jumpRequest.current === request) { setJump(null); setJumpFailed(true); } }
  }
  useEffect(() => {
    const request = new AbortController();
    void loadRoomHosting().then(async runtime => {
      await runtime.initializeRuntime();
      if (!request.signal.aborted) setMentionLimit(runtime.message_mention_limit());
    }).catch(() => { if (!request.signal.aborted) setMentionLimit(null); });
    if (!attachmentsAvailable) { setLimits(null); setLimitsFailed(false); return () => request.abort(); }
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
    const restore = () => {
      const saved = reading.current;
      node.scrollTop = saved.following ? node.scrollHeight : saved.position;
    };
    const view = node.ownerDocument.defaultView;
    const frame = view?.requestAnimationFrame(restore);
    return () => { if (frame !== undefined) view?.cancelAnimationFrame(frame); };
  }, [roomId, messages.length, hidden, loadingHistory, history?.atLatest, floating, surfaceDocument]);
  useLayoutEffect(() => {
    const node = log.current;
    if (hidden || !node) return;
    const view = node.ownerDocument.defaultView;
    if (!view) return;
    const observer = new view.ResizeObserver(() => {
      if (reading.current.following) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    if (content.current) observer.observe(content.current);
    return () => { observer.disconnect(); };
  }, [roomId, hidden, floating, surfaceDocument]);
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
    if ((!text && !files.length) || textTooLong || !canSend || working || composing.current) return;
    input.current?.focus({ preventScroll: true });
    reading.current.following = true;
    const request = new AbortController();
    preparing.current = request;
    setFileError("");
    try {
      const leading = draft.text.length - draft.text.trimStart().length;
      const mentions = draft.mentions.filter(mention => mention.start >= leading && mention.end <= leading + text.length)
        .map(mention => ({ ...mention, start: mention.start - leading, end: mention.end - leading }));
      const reply = draft.reply && { seq: draft.reply.seq, notify: draft.reply.notify };
      await onSend(roomId, text, files, request.signal, { mentions, ...(reply ? { reply } : {}) });
      setDrafts(previous => previous[roomId] === draft ? { ...previous, [roomId]: emptyDraft } : previous);
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
  return <section id="c3-chat" className="c3-conversation" hidden={hidden} aria-label={zh ? "房间聊天" : "Room chat"}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); addFiles([...event.dataTransfer.files]);
    }}>
    <div className="c3-chat-heading">{onBack ? <BackButton onClick={onBack} /> : <><Glyph name="chat" size={18} /><strong>{zh ? "聊天" : "Chat"}</strong></>}
      <span>{roomName}</span></div>
    <div className="c3-message-log" ref={log} role="log" aria-label={zh ? "消息" : "Messages"}
      onScroll={event => {
        const node = event.currentTarget, saved = reading.current;
        // Content growth can emit scroll without the reader moving upward.
        reading.current = { position: node.scrollTop, following: (saved.following && node.scrollTop >= saved.position)
          || node.scrollHeight - node.scrollTop - node.clientHeight < 60 };
        readVisible();
      }}>
      <div className="c3-message-content" ref={content}>
        {history?.hasMore && <div className="c3-history-more"><ChannelAction icon="arrowUp" quiet label={zh ? "更早的消息" : "Earlier messages"}
          busy={loadingHistory} disabled={!available} onClick={() => {
            const node = log.current;
            if (node) {
              const top = node.getBoundingClientRect().top;
              const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
                .find(element => element.getBoundingClientRect().bottom > top);
              readingAnchor.current = message ? { room: roomId, message: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top } : null;
            }
            const anchor = readingAnchor.current;
            reading.current.following = false;
            void onHistory(roomId).catch(() => {
              if (readingAnchor.current === anchor) readingAnchor.current = null;
            });
          }} /></div>}
        {!history?.hasMore && <ChannelRoomStart roomName={roomName} icon={roomIcon} canSend={canSend}
          entry={!roomId ? entry ?? { kind: "entry" } : undefined}
          empty={!messages.length && (!roomId || (!!history && !loadingHistory))} />}
        {roomId && loadingHistory && !messages.length && <div className="c3-conversation-loading" role="status">
          <Glyph name="loader" className="lr-spin" size={18} /><span>{zh ? "正在加载消息…" : "Loading messages…"}</span>
        </div>}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const date = new Date(message.time), previousDate = previous && new Date(previous.time);
          const newDay = !!previousDate && (date.getFullYear() !== previousDate.getFullYear()
            || date.getMonth() !== previousDate.getMonth() || date.getDate() !== previousDate.getDate());
          const elapsed = previous ? message.time - previous.time : 0;
          const after = unreadBoundary.room === roomId ? unreadBoundary.after : undefined;
          const newMessages = after !== undefined && message.seq > after && (!previous || previous.seq <= after);
          const grouped = !!previous && !newDay && !newMessages && !message.reply && previous.userId === message.userId && elapsed >= 0 && elapsed < 120_000;
          if (!grouped) authorMessageId = message.id;
          const author = users.find(user => user.id === message.userId);
          const name = messageAuthorName(message, users, zh ? "用户" : "User");
          return <MessageRow key={message.id} roomId={roomId} message={message} grouped={grouped} name={name} authorMessageId={authorMessageId}
            avatar={author?.avatar ?? undefined}
            users={users} selfUserId={selfUserId} unread={newMessages} onMessage={seq => { void showMessage(seq); }}
            onReply={() => { updateDraft(value => ({ ...value, reply: { seq: message.seq, notify: true, name, text: message.text || (zh ? "附件" : "Attachment") } })); input.current?.focus(); }}
            dateLabel={newDay ? date.toLocaleDateString(zh ? "zh-CN" : "en", { dateStyle: "long" }) : undefined}
            attachments={attachments} available={available} interaction={interaction} effectsEnabled={!hidden && !loadingHistory} />;
        })}
      </div>
    </div>
    {jumpFailed && <p className="c3-file-error" role="status">{zh ? "原消息暂不可用。" : "The original message is unavailable."}</p>}
    {roomId && (history?.atLatest === false || (!history && (!loadingHistory || messages.length > 0))) && <div className="c3-history-more"><ChannelAction icon={history ? "arrowDown" : "refresh"} quiet
      label={history ? (zh ? "最新消息" : "Latest messages") : (zh ? "加载消息" : "Load messages")} busy={loadingHistory} disabled={!available} onClick={() => {
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
    {textTooLong && <p id={textErrorId} className="c3-file-error" role="status">{zh
      ? `消息最多 ${MAX_MESSAGE_CODE_POINTS} 个字符，当前 ${textLength} 个。请缩短后发送。`
      : `Messages can contain up to ${MAX_MESSAGE_CODE_POINTS} characters (currently ${textLength}). Shorten your draft to send.`}</p>}
    {limitsFailed && <div className="c3-file-retry"><span>{zh ? "文件处理暂不可用" : "File preparation unavailable"}</span>
      <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setLimitsRetry(value => value + 1)} /></div>}
    {roomId && <form className="c3-composer" onSubmit={event => { void send(event); }}>
      {draft.reply && <div className="c3-compose-reply"><span><strong>{zh ? "回复 " : "Replying to "}{draft.reply.name}</strong><small>{draft.reply.text}</small></span>
        <Tooltip text={draft.reply.notify ? (zh ? "会提醒对方；关闭后只引用原消息" : "Notifies the author; turn off to quote without notifying")
          : (zh ? "不会提醒对方；开启后发送提醒" : "Doesn't notify the author; turn on to notify")}>
          <button type="button" className={`lr-btn is-compact is-quiet c3-reply-notify${draft.reply.notify ? " is-on" : ""}`} aria-pressed={draft.reply.notify}
            aria-label={zh ? "提醒回复对象" : "Notify reply recipient"} onClick={() => updateDraft(value => ({ ...value, reply: value.reply && { ...value.reply, notify: !value.reply.notify } }))}>@</button>
        </Tooltip>
        <ChannelAction icon="x" quiet iconOnly textTooltip label={zh ? "取消回复，保留草稿" : "Cancel reply and keep draft"} onClick={() => {
          updateDraft(value => ({ ...value, reply: undefined })); input.current?.focus({ preventScroll: true });
        }} />
      </div>}
      {query && <ChannelMentionSuggestions id={mentionId} anchor={input} users={candidates} activeIndex={activeMention} onActiveIndex={setMentionIndex} onSelect={selectMention} />}
      <div className="c3-compose-input">
      {attachmentsAvailable && <><input ref={chooser} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
        <ChannelAction icon="plus" label={zh ? "添加文件" : "Add files"} iconOnly quiet hint="hint-file-add"
          disabled={!canSend || working || !limits} onClick={() => chooser.current?.click()} /></>}
      <textarea ref={input} rows={1} enterKeyHint="enter" aria-label={zh ? "消息内容" : "Message"} value={draft.text}
        aria-autocomplete="list" aria-controls={query ? mentionId : undefined}
        aria-activedescendant={query && candidates[activeMention] ? `${mentionId}-${candidates[activeMention].id}` : undefined}
        aria-invalid={textTooLong || undefined} aria-describedby={textTooLong ? textErrorId : undefined}
        placeholder={zh ? "说点什么…" : "Say something…"} disabled={!roomId}
        onPaste={event => { if (attachmentsAvailable && event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        onChange={event => { const next = event.target.value; updateDraft(previous => ({ ...previous, text: next, mentions: editMentions(previous.text, next, previous.mentions) })); setMentionIndex(0); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); }}
        onSelect={event => { if (event.currentTarget.ownerDocument.activeElement === event.currentTarget) setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
        onBlur={() => setSelection(null)}
        onCompositionStart={() => { composing.current = true; setSelection(null); }}
        onCompositionEnd={event => { composing.current = false; setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (query && event.key === "Escape") { event.preventDefault(); setSelection(null); return; }
          if (query && candidates.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setMentionIndex((activeMention + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length); return; }
          if (query && candidates[activeMention] && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); selectMention(candidates[activeMention]); return; }
          if (event.key !== "Enter") return;
          const touchKeyboard = event.currentTarget.ownerDocument.defaultView?.matchMedia("(hover: none) and (pointer: coarse)").matches;
          if (event.ctrlKey || event.metaKey || (!event.shiftKey && !touchKeyboard)) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <ChannelAction icon="send" label={zh ? "发送" : "Send"} type="submit" primary iconOnly
        disabled={!canSend || textTooLong || (!text && !files.length)} busy={working} hint="hint-chat-send" />
      </div>
    </form>}
  </section>;
}

const MessageRow = memo(function MessageRow({ roomId, message, grouped, name, avatar, dateLabel, attachments, available, interaction, authorMessageId, effectsEnabled, users, selfUserId, unread, onReply, onMessage }: {
  roomId: string; message: ChannelMessage; grouped: boolean; name: string; avatar?: string; dateLabel?: string;
  attachments: ChannelAttachments; available: boolean; interaction: RoomInteractionSession | null;
  authorMessageId: string; effectsEnabled: boolean;
  users: ChannelUser[]; unread: boolean; onReply(): void; onMessage(seq: number): void;
  selfUserId?: string | null;
}) {
  const { lang } = useCopy();
  const mentioned = message.mentions?.some(mention => mention.userId === selfUserId)
    || (message.reply?.notify && message.reply.userId === selfUserId);
  const row = useRef<HTMLElement>(null);
  const effectAnchor = useCallback(() => row.current?.closest(".c3-message-content")
    ?.querySelector(`[data-message-id="${CSS.escape(authorMessageId)}"] > .lr-person`) ?? null, [authorMessageId]);
  return <>
    {dateLabel && <div className="c3-message-date"><time dateTime={new Date(message.time).toISOString()}>{dateLabel}</time></div>}
    {unread && <div className="c3-message-date c3-unread-divider">{lang === "zh" ? "新消息" : "New messages"}</div>}
    <article ref={row} tabIndex={-1} className={`c3-message c3-reaction-message${grouped ? " is-continuation" : ""}${mentioned ? " is-mentioned" : ""}`} data-message-id={message.id} data-message-seq={message.seq}>
    {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} avatar={avatar} />}
    <div className="c3-message-body">{!grouped && <div className="c3-message-meta"><strong>{name}</strong>
      <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
    </div>}<div className="c3-message-content-body">
    {message.reply && <button type="button" className="c3-message-reference" onClick={() => onMessage(message.reply!.seq)}>
      <Glyph name="arrowLeft" size={14} /><strong>{message.reply.archivedAuthorName ?? users.find(user => user.id === message.reply!.userId)?.name ?? (lang === "zh" ? "用户" : "User")}</strong>
      <span>{message.reply.text || (lang === "zh" ? "附件" : "Attachment")}</span></button>}
    {message.text && <p><MessageText message={message} users={users} selfUserId={selfUserId} /></p>}
    {message.attachments.map(file => <ChannelAttachment key={file.id} roomId={roomId} messageSeq={message.seq} file={file} client={attachments}
      inlineImage={message.inlineImages?.[file.id]} />)}
    <ChannelContentReactions reactions={message.reactions} session={interaction} target={{ messageSeq: message.seq }} disabled={!available}
      effectAnchor={effectAnchor} effectsEnabled={effectsEnabled} />
    <span className="c3-message-reply-action"><ChannelAction icon="arrowLeft" iconOnly quiet textTooltip
      label={!available ? (lang === "zh" ? "房间重新连接后可回复" : "Reply after the room reconnects") : (lang === "zh" ? "回复这条消息" : "Reply to this message")}
      disabled={!available} onClick={onReply} /></span>
    </div></div>
    </article>
  </>;
});

function MessageText({ message, users, selfUserId }: { message: ChannelMessage; users: ChannelUser[]; selfUserId?: string | null }) {
  let cursor = 0;
  const parts = (message.mentions ?? []).map((mention, index) => {
    const plain = message.text.slice(cursor, mention.start);
    cursor = mention.end;
    return <span key={index}>{plain}<mark className={`c3-message-mention${mention.userId === selfUserId ? " is-self" : ""}`} title={users.find(user => user.id === mention.userId)?.name}>
      {message.text.slice(mention.start, mention.end)}</mark></span>;
  });
  return <>{parts}{message.text.slice(cursor)}</>;
}
