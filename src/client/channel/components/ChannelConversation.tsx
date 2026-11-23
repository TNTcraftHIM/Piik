import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { motionDuration } from "../../ui/animation";
import { useCopy } from "../../ui/copy";
import { MAX_MESSAGE_CODE_POINTS, type ChannelMessage, type ChannelUser, type ChannelUserSummary } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsError } from "./ChannelSettingsDialog";
import { firstUnreadMessageId, messageAuthorName, messageDateFormats, sameCalendarDay } from "../presentation";
import { ChannelAttachment } from "./ChannelAttachment";
import { ChannelMessageContent } from "./ChannelMessageContent";
import { type AttachmentLimits, type DraftFile, type ChannelAttachments, fileSize } from "../attachments";
import { ChannelRoomStart, type ChannelEntry } from "./ChannelRoomStart";
import { ChannelContentReactions } from "./ChannelContentReactions";
import { BackButton } from "../../components/living/primitives";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { useSurfaceDocument } from "../../ui/panel-window";
import { Tooltip } from "../../components/living/Tooltip";
import { messageRemoved, type ChatOptions, type ChannelController } from "../types";
import { loadRoomHosting } from "../hosting";
import { ChannelMentionSuggestions, editMentions, matchingMentionUsers, mentionQuery } from "./ChannelMentionSuggestions";
import "./channel-conversation.css";

type Draft = { text: string; mentions: NonNullable<ChatOptions["mentions"]>; reply?: { seq: number; messageId: string; notify: boolean; name: string; text: string } };
const emptyDraft: Draft = { text: "", mentions: [] };

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ domainId, roomId, bindingId, roomName, roomIcon, roomPicture, entry, messages, users, profiles, queryProfiles, selfUserId, canSend, sending, onSend, hidden, floating = false, attachments, attachmentsAvailable = true, available, history, loadingHistory, onHistory, onLatest, onMessage, findUnreadMessage, unreadAfter, lastMessageSeq, onRead, interaction, onBack, onDeleteMessage, canModerate, pending, historyChanges }: {
  domainId: string | undefined; roomId: string; bindingId?: string; roomName: string; roomIcon?: string; roomPicture?: string; messages: ChannelMessage[]; users: ChannelUserSummary[];
  profiles: ReadonlyMap<string, ChannelUser>; queryProfiles: ChannelController["queryProfiles"];
  entry?: ChannelEntry;
  selfUserId?: string | null;
  canSend: boolean; sending: boolean; hidden: boolean; available: boolean;
  floating?: boolean;
  attachments: ChannelAttachments; attachmentsAvailable?: boolean; history?: ChannelController["historyByRoom"][string]; loadingHistory: boolean;
  onHistory: (roomId: string) => Promise<void>;
  onLatest: (roomId: string) => Promise<void>;
  onSend: ChannelController["sendMessage"];
  onMessage?: (roomId: string, seq: number) => Promise<void>;
  findUnreadMessage?: (roomId: string, after: number, signal: AbortSignal) => Promise<ChannelMessage | null>;
  onDeleteMessage?: (roomId: string, seq: number, messageId: string) => Promise<void>;
  canModerate?: boolean;
  pending?: ReadonlySet<string>;
  historyChanges?: ChannelController["historyChangesByRoom"][string];
  unreadAfter?: number; lastMessageSeq?: number; onRead?: (roomId: string, seq: number) => void;
  interaction: RoomInteractionSession | null;
  onBack?: () => void;
}) {
  const { lang, t } = useCopy();
  const surfaceDocument = useSurfaceDocument();
  const [{ today, timeZone }, setCalendar] = useState(() => ({
    today: new Date(), timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  useEffect(() => {
    const view = surfaceDocument?.defaultView;
    if (hidden || !surfaceDocument || !view) return;
    let timer: number | undefined;
    const refresh = () => {
      view.clearTimeout(timer);
      if (surfaceDocument.visibilityState === "hidden") return;
      const now = new Date();
      const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      setCalendar(previous => previous.timeZone === timeZone && sameCalendarDay(previous.today, now)
        ? previous : { today: now, timeZone });
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = view.setTimeout(refresh, midnight.getTime() - now.getTime());
    };
    refresh();
    surfaceDocument.addEventListener("visibilitychange", refresh);
    view.addEventListener("focus", refresh);
    return () => {
      view.clearTimeout(timer);
      surfaceDocument.removeEventListener("visibilitychange", refresh);
      view.removeEventListener("focus", refresh);
    };
  }, [surfaceDocument, hidden]);
  const [deleteFailure, setDeleteFailure] = useState<{ scope: string; code: string } | null>(null);
  const conversationScope = JSON.stringify([domainId, selfUserId, roomId]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionId = useId();
  const [jump, setJump] = useState<{ scope: string; seq: number; id?: string } | null>(null);
  const jumpRequest = useRef<object | null>(null);
  const [jumpFailed, setJumpFailed] = useState(false);
  const unreadLookup = useRef<AbortController | null>(null);
  const [unreadLookupBusy, setUnreadLookupBusy] = useState(false);
  const [unreadLookupError, setUnreadLookupError] = useState<string | null>(null);
  const [unreadBoundary, setUnreadBoundary] = useState({ scope: conversationScope, bindingId, after: unreadAfter });
  const [unreadLookupResult, setUnreadLookupResult] = useState<{ through: number; target?: string } | null>(null);
  const after = unreadBoundary.scope === conversationScope && unreadBoundary.bindingId === bindingId ? unreadBoundary.after : undefined;
  const lastSeq = messages.at(-1)?.seq ?? 0;
  const verifiedTarget = unreadLookupResult?.target;
  const unreadMessage = after !== undefined && verifiedTarget && messages.some(message => message.id === verifiedTarget)
    ? verifiedTarget : firstUnreadMessageId(messages, after, selfUserId, history?.hasMore ?? true);
  const canSeekUnread = findUnreadMessage && after !== undefined && history?.hasMore
    && (messages[0]?.seq ?? 0) > after + 1
    && (!unreadLookupResult || !!verifiedTarget || lastSeq > unreadLookupResult.through);
  // Capture a visit's divider before markRead advances the durable personal cursor.
  useLayoutEffect(() => {
    setUnreadBoundary(previous => previous.scope !== conversationScope || previous.bindingId !== bindingId || !hidden
      ? { scope: conversationScope, bindingId, after: unreadAfter } : previous);
  }, [conversationScope, bindingId, hidden]);
  const [draftFiles, setDraftFiles] = useState<Record<string, DraftFile[]>>({});
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [mentionLimit, setMentionLimit] = useState<number | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [limitsRetry, setLimitsRetry] = useState(0);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [preparations, setPreparations] = useState<Record<string, { percent: number; cancel: () => void }>>({});
  const preparationProgressId = useId();
  const percentFormat = useMemo(() => new Intl.NumberFormat(lang, { style: "percent" }), [lang]);
  const identityLifetime = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const chooser = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const latestAction = useRef<HTMLDivElement>(null);
  const [offscreenUnread, setOffscreenUnread] = useState<string>();
  useLayoutEffect(() => {
    setOffscreenUnread(undefined);
    const root = log.current, marker = root?.querySelector(".c3-unread-divider");
    if (hidden || !unreadMessage || !root || !marker) return;
    const observer = new IntersectionObserver(([entry]) => {
      setOffscreenUnread(entry.isIntersecting ? undefined : unreadMessage);
    }, { root });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [conversationScope, unreadMessage, hidden, surfaceDocument]);
  const content = useRef<HTMLDivElement>(null);
  const reading = useRef({ position: 0, following: true });
  const [followingLatest, setFollowingLatest] = useState(true);
  const setFollowing = useCallback((following: boolean) => {
    if (reading.current.following === following) return;
    reading.current.following = following;
    setFollowingLatest(following);
  }, []);
  const readingAnchor = useRef<{ scope: string; message: string; offset: number } | null>(null);
  const lastArrival = useRef<{ scope: string; seq: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const previous = lastArrival.current;
    const ready = !hidden && !loadingHistory && history?.atLatest === true;
    lastArrival.current = { scope: conversationScope, seq: messages.at(-1)?.seq ?? 0, ready };
    if (!ready || !previous?.ready || previous.scope !== conversationScope || !reading.current.following || !log.current) return;
    const duration = motionDuration(log.current, "surface");
    if (!duration) return;
    for (const row of log.current.querySelectorAll<HTMLElement>("[data-message-seq]")) {
      if (Number(row.dataset.messageSeq) > previous.seq) {
        row.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration, easing: "cubic-bezier(.2, 0, 0, 1)" });
      }
    }
  }, [messages, conversationScope, hidden, loadingHistory, history?.atLatest]);
  const draft = drafts[conversationScope] ?? emptyDraft;
  const quote = draft.reply;
  const projectedTarget = quote && messages.find(message => message.seq === quote.seq);
  const quoteUnavailable = !!quote && (messageRemoved(historyChanges, quote.seq)
    || !!projectedTarget && projectedTarget.id !== quote.messageId);
  const draftReply = quoteUnavailable ? undefined : quote;
  const clearReply = useCallback((messageId: string) => {
    setDrafts(previous => {
      const value = previous[conversationScope];
      if (value?.reply?.messageId !== messageId) return previous;
      return { ...previous, [conversationScope]: { ...value, reply: undefined } };
    });
  }, [conversationScope]);
  useEffect(() => {
    if (quoteUnavailable && quote) clearReply(quote.messageId);
  }, [quoteUnavailable, quote, clearReply]);
  const text = draft.text;
  const hasText = text.trim().length > 0;
  const query = selection && !composing.current && mentionLimit !== null && draft.mentions.length < mentionLimit
    && !draft.mentions.some(mention => selection.start > mention.start && selection.start <= mention.end)
    ? mentionQuery(draft.text, selection.start, selection.end) : null;
  const queryText = query && !hidden ? query.query : null;
  const [mentionPage, setMentionPage] = useState<{ query: string; ids: string[]; next: string | null }>({ query: "", ids: [], next: null });
  const [mentionLoading, setMentionLoading] = useState(false), [mentionFailed, setMentionFailed] = useState(false);
  const mentionRequest = useRef<AbortController | null>(null);
  const [mentionRetry, setMentionRetry] = useState(0);
  const candidates = useMemo(() => {
    if (queryText === null) return [];
    const localCandidates = matchingMentionUsers(users, queryText);
    const matchingIds = new Set(localCandidates.map(user => user.id));
    if (mentionPage.query === queryText) {
      for (const id of mentionPage.ids) matchingIds.add(id);
    }
    return matchingMentionUsers([...matchingIds].flatMap(id => {
      const summary = users.find(user => user.id === id), profile = profiles.get(id);
      return summary ? [{ ...summary, avatar: summary.version === profile?.version ? profile.avatar : null }]
        : profile ? [profile] : [];
    }), queryText);
  }, [users, profiles, queryText, mentionPage]);
  const moreMentions = mentionPage.query === queryText && mentionPage.next !== null;
  async function loadMentions(after?: string) {
    if (queryText === null) return;
    mentionRequest.current?.abort();
    const current = mentionRequest.current = new AbortController(), search = queryText;
    setMentionLoading(true); setMentionFailed(false);
    try {
      const page = await queryProfiles({ query: search, ...(after ? { after } : {}) }, current.signal);
      if (!current.signal.aborted) setMentionPage(previous => ({ query: search,
        ids: [...new Set([...(after && previous.query === search ? previous.ids : []), ...page.profiles.map(user => user.id)])], next: page.nextCursor }));
    } catch { if (!current.signal.aborted) setMentionFailed(true); }
    finally { if (!current.signal.aborted) setMentionLoading(false); }
  }
  useEffect(() => {
    setMentionPage({ query: queryText ?? "", ids: [], next: null }); setMentionIndex(0); setMentionFailed(false); setMentionLoading(false);
    if (queryText !== null && available) void loadMentions();
    return () => { mentionRequest.current?.abort(); };
  }, [queryText, queryProfiles, available, conversationScope, mentionRetry]);
  const activeMention = Math.min(mentionIndex, candidates.length - 1);
  const textLength = Array.from(text).length;
  const textTooLong = textLength > MAX_MESSAGE_CODE_POINTS;
  const textErrorId = useId();
  const files = draftFiles[conversationScope] ?? [];
  const fileError = draftErrors[conversationScope] ?? "";
  const setFileError = (error: string) => setDraftErrors(previous => ({ ...previous, [conversationScope]: error }));
  const preparation = preparations[conversationScope];
  const working = sending || !!preparation;
  const updateDraft = useCallback((update: (previous: Draft) => Draft) => {
    setDrafts(previous => ({ ...previous, [conversationScope]: update(previous[conversationScope] ?? emptyDraft) }));
  }, [conversationScope]);
  const selectMention = useCallback((user: Pick<ChannelUser, "id" | "name">, replacement?: { start: number; end: number }) => {
    const field = input.current;
    if (!field) return;
    const range = replacement ?? { start: field.selectionStart, end: field.selectionEnd };
    const prefix = range.start > 0 && !/\s/.test(field.value[range.start - 1]) ? " " : "";
    const inserted = `${prefix}@${user.name} `;
    const next = field.value.slice(0, range.start) + inserted + field.value.slice(range.end);
    updateDraft(previous => ({ ...previous, text: next,
      mentions: [...editMentions(previous.text, next, previous.mentions, range), { userId: user.id, start: range.start + prefix.length, end: range.start + inserted.length - 1 }].sort((a, b) => a.start - b.start) }));
    const caret = range.start + inserted.length;
    setSelection(null);
    field.focus();
    surfaceDocument?.defaultView?.requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  }, [surfaceDocument, updateDraft]);
  function readVisible() {
    const node = log.current, doc = node?.ownerDocument;
    if (!hidden && !unreadLookup.current && !unreadLookupBusy && !jump?.id && roomId && available && !loadingHistory && history?.atLatest && node?.getClientRects().length
      && doc?.visibilityState === "visible" && doc.hasFocus() && !doc.querySelector("dialog:modal") && doc.defaultView?.getComputedStyle(node).visibility === "visible"
      && (!doc.fullscreenElement || doc.fullscreenElement.contains(node)) && node.scrollHeight - node.scrollTop - node.clientHeight < 4) {
      const seq = messages.at(-1)?.seq ?? history.emptyThrough;
      if (seq !== undefined) onRead?.(roomId, seq);
    }
  }
  useLayoutEffect(() => {
    const doc = surfaceDocument, view = doc?.defaultView;
    const frame = view?.requestAnimationFrame(readVisible);
    doc?.addEventListener("fullscreenchange", readVisible);
    doc?.addEventListener("visibilitychange", readVisible);
    doc?.addEventListener("close", readVisible, true);
    view?.addEventListener("focus", readVisible, true);
    return () => {
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
      doc?.removeEventListener("fullscreenchange", readVisible);
      doc?.removeEventListener("visibilitychange", readVisible);
      doc?.removeEventListener("close", readVisible, true);
      view?.removeEventListener("focus", readVisible, true);
    };
  }, [conversationScope, messages, hidden, available, loadingHistory, history?.atLatest, history?.emptyThrough, lastMessageSeq, unreadLookupBusy, jump?.id, surfaceDocument, onRead]);
  useLayoutEffect(() => {
    if (!jump || jump.scope !== conversationScope || hidden || loadingHistory) return;
    const target = log.current?.querySelector<HTMLElement>(`[data-message-seq="${jump.seq}"]`);
    if (target && (!jump.id || target.dataset.messageId === jump.id)) {
      target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true });
      if (!target.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        target.animate([{ backgroundColor: "color-mix(in srgb, var(--action) 18%, transparent)" }, { backgroundColor: getComputedStyle(target).backgroundColor }], { duration: motionDuration(target, "emphasis"), easing: "ease-out" });
      }
      reading.current.position = log.current!.scrollTop;
      setFollowing(false);
      setJump(null);
    }
  }, [jump, conversationScope, hidden, loadingHistory, messages, setFollowing]);
  useLayoutEffect(() => { setSelection(null); setJump(null); jumpRequest.current = null; setJumpFailed(false); composing.current = false; }, [conversationScope]);
  const cancelUnreadLookup = useCallback(() => {
    unreadLookup.current?.abort();
    unreadLookup.current = null;
    setUnreadLookupBusy(false);
    setUnreadLookupError(null);
    setJump(previous => previous?.id ? null : previous);
  }, []);
  // Reply jumps need the displayed window without replacing every row callback.
  const committedMessages = useRef(messages);
  useLayoutEffect(() => { committedMessages.current = messages; }, [messages]);
  const showMessage = useCallback(async (seq: number) => {
    cancelUnreadLookup();
    setJumpFailed(false); readingAnchor.current = null; setFollowing(false);
    const request = { scope: conversationScope, seq };
    jumpRequest.current = request; setJump(request);
    if (committedMessages.current.some(message => message.seq === seq)) return;
    try { if (!onMessage) throw new Error("unavailable"); await onMessage(roomId, seq); }
    catch { if (jumpRequest.current === request) { setJump(null); setJumpFailed(true); } }
  }, [cancelUnreadLookup, conversationScope, onMessage, roomId, setFollowing]);
  async function jumpToUnread() {
    const target = messages.find(message => message.id === unreadMessage);
    if (target) { await showMessage(target.seq); return; }
    if (!findUnreadMessage || after === undefined || hidden || !available) return;
    cancelUnreadLookup();
    setJump(null); jumpRequest.current = null; setJumpFailed(false);
    const controller = unreadLookup.current = new AbortController();
    setUnreadLookupBusy(true);
    try {
      const message = await findUnreadMessage(roomId, after, controller.signal);
      if (controller.signal.aborted) return;
      setUnreadLookupResult({ through: lastSeq, target: message?.id });
      if (message) {
        readingAnchor.current = null; setFollowing(false);
        setJump({ scope: conversationScope, seq: message.seq, id: message.id });
      }
    } catch (error) {
      if (!controller.signal.aborted) setUnreadLookupError(error instanceof Error ? error.message : "operation_failed");
    }
    finally { if (unreadLookup.current === controller) { unreadLookup.current = null; setUnreadLookupBusy(false); } }
  }
  useLayoutEffect(() => {
    cancelUnreadLookup();
    const onVisibilityChange = () => {
      if (surfaceDocument?.visibilityState === "hidden") cancelUnreadLookup();
    };
    surfaceDocument?.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      surfaceDocument?.removeEventListener("visibilitychange", onVisibilityChange);
      unreadLookup.current?.abort();
    };
  }, [conversationScope, hidden, available, unreadBoundary, findUnreadMessage, surfaceDocument]);
  useLayoutEffect(() => setUnreadLookupResult(null), [unreadBoundary]);
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
  useLayoutEffect(() => {
    const request = identityLifetime.current = new AbortController();
    return () => request.abort();
  }, [domainId, selfUserId]);
  useLayoutEffect(() => {
    readingAnchor.current = null;
    reading.current.position = 0;
    setFollowing(true);
  }, [conversationScope, setFollowing]);
  useLayoutEffect(() => { if (history?.atLatest) setFollowing(true); }, [history?.atLatest, setFollowing]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (anchor?.scope === conversationScope && !loadingHistory && log.current) {
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
  }, [conversationScope, messages.length, hidden, loadingHistory, history?.atLatest, floating, surfaceDocument]);
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
  }, [conversationScope, hidden, floating, surfaceDocument]);
  function addFiles(incoming: File[]) {
    if (!attachmentsAvailable || !limits || working || !canSend) return;
    if (files.length + incoming.length > limits.maxAttachmentsPerMessage) {
      setFileError(t("conversation.attachmentLimit", { max: String(limits.maxAttachmentsPerMessage) }));
      return;
    }
    if (incoming.some(file => file.size > limits.maxFileBytes)) {
      setFileError(t("conversation.attachmentSizeLimit"));
      return;
    }
    setFileError("");
    setDraftFiles(previous => ({ ...previous, [conversationScope]: [...(previous[conversationScope] ?? []), ...incoming.map(file => ({ id: crypto.randomUUID(), file }))] }));
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if ((!hasText && !files.length) || textTooLong || !canSend || working || composing.current) return;
    input.current?.focus({ preventScroll: true });
    setFollowing(true);
    const request = identityLifetime.current!;
    setFileError("");
    const controller = files.length ? new AbortController() : undefined;
    const cancel = () => {
      controller?.abort();
      input.current?.focus({ preventScroll: true });
    };
    const progress = (percent: number | null) => setPreparations(previous => {
      if (percent !== null) return { ...previous, [conversationScope]: { percent, cancel } };
      if (previous[conversationScope]?.cancel !== cancel) return previous;
      const next = { ...previous };
      delete next[conversationScope];
      return next;
    });
    if (controller) progress(0);
    try {
      const mentions = draft.mentions;
      const reply = draftReply && { seq: draftReply.seq, messageId: draftReply.messageId, notify: draftReply.notify };
      await onSend(roomId, text, files, request.signal, { mentions, ...(reply ? { reply } : {}) },
        controller && { signal: controller.signal, progress });
      setDrafts(previous => previous[conversationScope] === draft ? { ...previous, [conversationScope]: emptyDraft } : previous);
      setDraftFiles(previous => ({ ...previous, [conversationScope]: (previous[conversationScope] ?? []).filter(value => !files.some(file => file.id === value.id)) }));
    } catch (error) {
      if (request.signal.aborted || (controller?.signal.aborted && error instanceof DOMException && error.name === "AbortError")) return;
      if (draftReply && error instanceof Error && error.message === "message_unavailable") {
        clearReply(draftReply.messageId);
        setFileError(t("conversation.replyTargetGone"));
      } else {
        setFileError(t("conversation.sendFailed"));
      }
    } finally {
      if (controller) progress(null);
    }
  }
  function removeFile(entry: DraftFile) {
    if (working) return;
    setFileError("");
    setDraftFiles(previous => ({ ...previous, [conversationScope]: (previous[conversationScope] ?? []).filter(value => value.id !== entry.id) }));
  }
  const canMention = available && mentionLimit !== null && draft.mentions.length < mentionLimit;
  const replyToMessage = useCallback((reply: NonNullable<Draft["reply"]>) => {
    cancelUnreadLookup();
    updateDraft(value => ({ ...value, reply }));
    input.current?.focus();
  }, [cancelUnreadLookup, updateDraft]);
  const deleteMessage = useCallback((message: ChannelMessage) => {
    setDeleteFailure(null);
    void onDeleteMessage?.(roomId, message.seq, message.id).catch(error => {
      setDeleteFailure({ scope: conversationScope, code: error instanceof Error ? error.message : "operation_failed" });
    });
  }, [conversationScope, onDeleteMessage, roomId]);
  return <section id="c3-chat" className="c3-conversation" hidden={hidden} aria-label={t("conversation.roomChat")}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); addFiles([...event.dataTransfer.files]);
    }}>
    <div className="c3-chat-heading">{onBack ? <BackButton onClick={onBack} /> : <><Glyph name="chat" size={18} /><strong>{t("conversation.chat")}</strong></>}
      <span>{roomName}</span></div>
    {(unreadLookupBusy || (unreadMessage ? offscreenUnread === unreadMessage : canSeekUnread)) &&
      <div className="c3-history-more"><ChannelAction icon="chat" quiet busy={unreadLookupBusy || loadingHistory} disabled={!available}
        label={t("conversation.jumpToNew")} onClick={() => { void jumpToUnread(); }} /></div>}
    <ChannelSettingsError error={unreadLookupError} />
    <div className="c3-message-log" ref={log} tabIndex={-1} role="log" aria-label={t("conversation.messages")}
      onScroll={event => {
        const node = event.currentTarget;
        // Content growth can emit scroll without the reader moving upward.
        setFollowing((reading.current.following && node.scrollTop >= reading.current.position)
          || node.scrollHeight - node.scrollTop - node.clientHeight < 60);
        reading.current.position = node.scrollTop;
        readVisible();
      }}>
      <div className="c3-message-content" ref={content}>
        {history?.hasMore && <div className="c3-history-more"><ChannelAction icon="arrowUp" quiet label={t("conversation.earlier")}
          busy={loadingHistory} disabled={!available} onClick={() => {
            cancelUnreadLookup();
            const node = log.current;
            if (node) {
              const top = node.getBoundingClientRect().top;
              const message = [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
                .find(element => element.getBoundingClientRect().bottom > top);
              readingAnchor.current = message ? { scope: conversationScope, message: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top } : null;
            }
            const anchor = readingAnchor.current;
            setFollowing(false);
            void onHistory(roomId).catch(() => {
              if (readingAnchor.current === anchor) readingAnchor.current = null;
            });
          }} /></div>}
        {(!roomId || available) && !history?.hasMore && !messages.length && (!roomId || (!!history && !loadingHistory)) &&
          <ChannelRoomStart icon={roomIcon} picture={roomPicture} canSend={canSend} entry={!roomId ? entry ?? { kind: "entry" } : undefined} />}
        {roomId && loadingHistory && !messages.length && <div className="c3-conversation-loading" role="status">
          <Glyph name="loader" className="lr-spin" size={18} /><span>{t("conversation.loading")}</span>
        </div>}
        <MessageHistory roomId={roomId} messages={messages} users={users} profiles={profiles} selfUserId={selfUserId}
          today={today} timeZone={timeZone} unreadMessage={unreadMessage} attachments={attachments} available={available}
          interaction={interaction} effectsEnabled={!hidden && !loadingHistory} canMention={canMention}
          canModerate={canModerate} pending={pending} onReply={replyToMessage} onMention={selectMention}
          onMessage={loadingHistory ? undefined : showMessage} onDelete={onDeleteMessage ? deleteMessage : undefined} />
      </div>
    </div>
    <ChannelSettingsError error={deleteFailure?.scope === conversationScope ? deleteFailure.code : null} />
    {jumpFailed && <p className="c3-file-error" role="status">{t("conversation.originalUnavailable")}</p>}
    {roomId && (history ? !history.atLatest || !followingLatest : !loadingHistory || messages.length > 0) && <div className="c3-history-more" ref={latestAction}><ChannelAction icon={history ? "arrowDown" : "refresh"} quiet
      label={history ? t("conversation.latest") : t("conversation.load")} busy={loadingHistory} disabled={!history?.atLatest && !available} onClick={() => {
        cancelUnreadLookup();
        readingAnchor.current = null;
        const node = log.current;
        if (node && latestAction.current?.contains(node.ownerDocument.activeElement)) node.focus({ preventScroll: true });
        if (!history?.atLatest) {
          void onLatest(roomId).catch(() => {});
        } else if (node) {
          node.scrollTop = node.scrollHeight;
          reading.current.position = node.scrollTop;
        }
        setFollowing(true);
      }} /></div>}
    {files.length > 0 && <div className="c3-draft-files">{files.map(entry => <div key={entry.id}>
      <Glyph name="save" size={15} /><span>{entry.file.name}</span><small>{fileSize(entry.file.size)}</small>
      <ChannelAction icon="x" iconOnly quiet label={t("conversation.removeFile")} disabled={working} hint="hint-close"
        onClick={() => { void removeFile(entry); }} />
    </div>)}</div>}
    {preparation && <div className="c3-file-preparation">
      <div className="c3-attachment-progress">
        <label htmlFor={preparationProgressId}>{t("conversation.preparingAttachments")}{" "}
          <span aria-hidden="true">{percentFormat.format(preparation.percent / 100)}</span>
        </label>
        <progress id={preparationProgressId} value={preparation.percent} max={100} />
      </div>
      <ChannelAction icon="x" quiet label={t("conversation.cancelAttachmentPreparation")} onClick={preparation.cancel} />
    </div>}
    {fileError && <p className="c3-file-error" role="status">{fileError}</p>}
    {textTooLong && <p id={textErrorId} className="c3-file-error" role="status">{t("conversation.textTooLong", { max: String(MAX_MESSAGE_CODE_POINTS), count: String(textLength) })}</p>}
    {limitsFailed && <div className="c3-file-retry"><span>{t("conversation.filesUnavailable")}</span>
      <ChannelAction icon="refresh" quiet label={t("conversation.retry")} onClick={() => setLimitsRetry(value => value + 1)} /></div>}
    {roomId && <form className="c3-composer" onSubmit={event => { void send(event); }}>
      {draftReply && <div className="c3-compose-reply"><span><strong>{t("conversation.replyingTo", { name: draftReply.name })}</strong><small>{draftReply.text}</small></span>
        <Tooltip text={draftReply.notify ? t("conversation.replyNotifyOn")
          : t("conversation.replyNotifyOff")}>
          <button type="button" className={`lr-btn is-compact is-quiet c3-reply-notify${draftReply.notify ? " is-on" : ""}`} aria-pressed={draftReply.notify}
            aria-label={t("conversation.replyNotify")} onClick={() => updateDraft(value => ({ ...value, reply: value.reply && { ...value.reply, notify: !value.reply.notify } }))}>@</button>
        </Tooltip>
        <ChannelAction icon="x" quiet iconOnly textTooltip label={t("conversation.cancelReply")} onClick={() => {
          updateDraft(value => ({ ...value, reply: undefined })); input.current?.focus({ preventScroll: true });
        }} />
      </div>}
      {query && <ChannelMentionSuggestions id={mentionId} anchor={input} users={candidates} activeIndex={activeMention} onActiveIndex={setMentionIndex} onSelect={user => selectMention(user, query)}
        loading={mentionLoading} error={mentionFailed} hasMore={moreMentions} onMore={() => {
          if (mentionFailed && !mentionPage.ids.length) setMentionRetry(value => value + 1);
          else void loadMentions(mentionPage.next ?? undefined);
        }} />}
      <div className="c3-compose-input">
      {attachmentsAvailable && <><input ref={chooser} type="file" multiple hidden onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
        <ChannelAction icon="plus" label={t("conversation.addFiles")} iconOnly quiet hint="hint-file-add"
          disabled={!canSend || working || !limits} onClick={() => chooser.current?.click()} /></>}
      <textarea ref={input} rows={1} enterKeyHint="enter" aria-label={t("conversation.message")} value={draft.text}
        aria-autocomplete="list" aria-controls={query ? mentionId : undefined}
        aria-activedescendant={query && candidates[activeMention] ? `${mentionId}-${candidates[activeMention].id}` : undefined}
        aria-invalid={textTooLong || undefined} aria-describedby={textTooLong ? textErrorId : undefined}
        placeholder={t("conversation.placeholder")} disabled={!roomId}
        onPaste={event => { if (attachmentsAvailable && event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        onChange={event => { const next = event.target.value; updateDraft(previous => ({ ...previous, text: next, mentions: editMentions(previous.text, next, previous.mentions) })); setMentionIndex(0); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); }}
        onSelect={event => { if (event.currentTarget.ownerDocument.activeElement === event.currentTarget) setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
        onBlur={() => {
          composing.current = false;
          setSelection(null);
        }}
        onCompositionStart={() => { composing.current = true; setSelection(null); }}
        onCompositionEnd={event => {
          // Closing the detached window can finish composition after blur.
          if (!composing.current) return;
          composing.current = false;
          setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
        }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (query && event.key === "Escape") { event.preventDefault(); setSelection(null); return; }
          if (query && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            if (event.key === "ArrowDown" && activeMention === candidates.length - 1 && (moreMentions || mentionFailed) && !mentionLoading) {
              void loadMentions(mentionPage.next ?? undefined); setMentionIndex(candidates.length);
            } else if (candidates.length) setMentionIndex((activeMention + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
            return;
          }
          if (query && candidates[activeMention] && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); selectMention(candidates[activeMention], query); return; }
          if (event.key !== "Enter") return;
          const touchKeyboard = event.currentTarget.ownerDocument.defaultView?.matchMedia("(hover: none) and (pointer: coarse)").matches;
          if (event.ctrlKey || event.metaKey || (!event.shiftKey && !touchKeyboard)) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <ChannelAction icon="send" label={t("conversation.send")} type="submit" primary iconOnly
        disabled={!canSend || textTooLong || (!hasText && !files.length)} busy={working} hint="hint-chat-send" />
      </div>
    </form>}
  </section>;
}

const MessageHistory = memo(function MessageHistory({ roomId, messages, users, profiles, selfUserId,
  today, timeZone, unreadMessage, attachments, available, interaction, effectsEnabled, canMention,
  canModerate, pending, onReply, onMention, onMessage, onDelete }: {
  roomId: string; messages: ChannelMessage[]; users: ChannelUserSummary[]; profiles: ReadonlyMap<string, ChannelUser>;
  selfUserId?: string | null; today: Date; timeZone: string; unreadMessage?: string;
  attachments: ChannelAttachments; available: boolean; interaction: RoomInteractionSession | null;
  effectsEnabled: boolean; canMention: boolean; canModerate?: boolean; pending?: ReadonlySet<string>;
  onReply(reply: NonNullable<Draft["reply"]>): void;
  onMention(user: Pick<ChannelUser, "id" | "name">): void;
  onMessage?(seq: number): void;
  onDelete?(message: ChannelMessage): void;
}) {
  const { lang, t } = useCopy();
  const formats = useMemo(() => messageDateFormats(lang, timeZone), [lang, timeZone]);
  const displayUsers = useMemo(() =>
    [...new Map([...profiles.values(), ...users].map(user => [user.id, user])).values()], [profiles, users]);
  let authorMessageId = "";
  let previousDate: Date | undefined;
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const date = new Date(message.time);
    const newDay = !previousDate || !sameCalendarDay(date, previousDate);
    previousDate = date;
    const elapsed = previous ? message.time - previous.time : 0;
    const newMessages = message.id === unreadMessage;
    const grouped = !!previous && !newDay && !newMessages && !message.reply && previous.userId === message.userId && elapsed >= 0 && elapsed < 120_000;
    if (!grouped) authorMessageId = message.id;
    const author = profiles.get(message.userId), summary = users.find(user => user.id === message.userId);
    const name = messageAuthorName(message, displayUsers, t("conversation.user"));
    const mentionName = canMention ? displayUsers.find(user => user.id === message.userId)?.name : undefined;
    const reply = message.reply;
    const replyName = reply && (reply.archivedAuthorName ?? displayUsers.find(user => user.id === reply.userId)?.name);
    // Only rendered mention marks need the live user directory.
    return <MessageRow key={message.id} roomId={roomId} message={message} grouped={grouped} name={name} authorMessageId={authorMessageId}
      avatar={(!summary || summary.version === author?.version ? author?.avatar : null) ?? undefined}
      mentionUsers={message.mentions?.length ? displayUsers : undefined} replyName={replyName} selfUserId={selfUserId} unread={newMessages} onMessage={onMessage}
      onReply={onReply}
      onDelete={canModerate || message.userId === selfUserId ? onDelete : undefined}
      deleting={pending?.has(`delete-message:${roomId}:${message.id}`)}
      mentionName={mentionName} onMention={onMention}
      newDay={newDay} formats={formats} today={today}
      attachments={attachments} available={available} interaction={interaction} effectsEnabled={effectsEnabled} />;
  });
});

const noMentionUsers: readonly ChannelUserSummary[] = [];

const MessageRow = memo(function MessageRow({ roomId, message, grouped, name, avatar, newDay, formats, today, attachments, available, interaction, authorMessageId, effectsEnabled, mentionUsers = noMentionUsers, replyName, selfUserId, unread, onReply, onMessage, mentionName, onMention, onDelete, deleting }: {
  roomId: string; message: ChannelMessage; grouped: boolean; name: string; avatar?: string;
  newDay: boolean; formats: ReturnType<typeof messageDateFormats>; today: Date;
  attachments: ChannelAttachments; available: boolean; interaction: RoomInteractionSession | null;
  authorMessageId: string; effectsEnabled: boolean;
  mentionUsers?: readonly ChannelUserSummary[]; replyName?: string; unread: boolean; onReply(reply: NonNullable<Draft["reply"]>): void; onMessage?(seq: number): void;
  selfUserId?: string | null;
  mentionName?: string;
  onMention(user: Pick<ChannelUser, "id" | "name">): void;
  onDelete?(message: ChannelMessage): void;
  deleting?: boolean;
}) {
  const { t } = useCopy();
  const mentioned = message.mentions?.some(mention => mention.userId === selfUserId)
    || (message.reply?.notify && message.reply.userId === selfUserId);
  const row = useRef<HTMLElement>(null);
  const effectAnchor = useCallback(() => row.current?.closest(".c3-message-content")
    ?.querySelector(`[data-message-id="${CSS.escape(authorMessageId)}"] > .lr-person`) ?? null, [authorMessageId]);
  const date = new Date(message.time);
  const iso = date.toISOString(), tooltip = formats.tooltip(date);
  return <>
    {newDay && <div className="c3-message-date"><time dateTime={iso}>{formats.divider(date)}</time></div>}
    {unread && <div className="c3-message-date c3-unread-divider">{t("conversation.newMessages")}</div>}
    <article ref={row} tabIndex={0} className={`c3-message c3-reaction-message${grouped ? " is-continuation" : ""}${mentioned ? " is-mentioned" : ""}`} data-message-id={message.id} data-message-seq={message.seq}>
    {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} avatar={avatar} />}
    <div className="c3-message-body"><div className={grouped ? "visually-hidden" : "c3-message-meta"}><strong>{name}</strong>
      <time dateTime={iso} title={tooltip} aria-label={tooltip}>{formats.clock(date, today)}</time>
    </div><div className="c3-message-content-body">
    {message.reply && <button type="button" className="c3-message-reference" disabled={!onMessage} onClick={() => onMessage?.(message.reply!.seq)}>
      <Glyph name="reply" size={14} /><strong>{replyName ?? t("conversation.user")}</strong>
      <span>{message.reply.text || t("conversation.attachment")}</span></button>}
    {message.text && <ChannelMessageContent message={message} users={mentionUsers} selfUserId={selfUserId} />}
    {message.attachments.map(file => <ChannelAttachment key={file.id} roomId={roomId} messageSeq={message.seq} file={file} client={attachments}
      inlineImage={message.inlineImages?.[file.id]} />)}
    <ChannelContentReactions reactions={message.reactions} session={interaction} target={{ messageSeq: message.seq, messageId: message.id }} disabled={!available}
      effectAnchor={effectAnchor} effectsEnabled={effectsEnabled} actions={<>
      <Tooltip text={t("conversation.mention", { name })}><button type="button" className="lr-btn is-compact is-quiet c3-mention-author" aria-label={t("conversation.mention", { name })}
        disabled={mentionName === undefined} onClick={() => { if (mentionName !== undefined) onMention({ id: message.userId, name: mentionName }); }}>@</button></Tooltip>
      <ChannelAction icon="reply" iconOnly quiet textTooltip
      label={!available ? t("conversation.replyUnavailable") : t("conversation.reply")}
      disabled={!available} onClick={() => onReply({
        seq: message.seq, messageId: message.id, notify: true, name, text: message.text || t("conversation.attachment"),
      })} />
      {onDelete && <ChannelAction icon="x" iconOnly quiet danger textTooltip label={t("conversation.deleteMessage")}
        disabled={!available} busy={deleting} onClick={() => {
          if (row.current?.ownerDocument.defaultView?.confirm(t("conversation.confirmDeleteMessage"))) onDelete(message);
        }} />}</>} />
    </div></div>
    </article>
  </>;
});
