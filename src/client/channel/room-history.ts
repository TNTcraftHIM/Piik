import type { ChannelMessage, ConversationReply, MessageReactionSnapshot } from "./protocol";
import { messageRemoved, type ChannelView, type RoomHistoryChanges } from "./types";
import { mergeMessage, mergeMessages, readingWindow, redactReply } from "./message-history";

/** A reread of the cached window, shared by the requests that page through it. */
export interface HistoryRefresh {
  from: number;
  through: number;
  latest: boolean;
  before?: number;
  window: ChannelMessage[];
}

export type HistoryPaging = ChannelView["historyByRoom"][string];
type HistoryEnd = Extract<ConversationReply["record"], { type: "history_end" }>;

interface PendingPage {
  bindingId?: string;
  before?: number;
  replace: boolean;
  refresh?: HistoryRefresh;
  latestThrough?: number;
  entries: Map<number, { message?: ChannelMessage; snapshot?: MessageReactionSnapshot }>;
  // Rows adjoining the requested page, bounded in its direction of travel.
  window: ChannelMessage[];
  clipped?: boolean;
}

/** A page whose records all arrived; the session removes `missing` before merging it. */
export interface CompletedPage { readonly missing: number[]; readonly page: PendingPage; readonly rows: ChannelMessage[]; readonly current: ChannelMessage[]; readonly end: HistoryEnd }

// Bounds the entries one page under assembly may collect.
const pageEntryLimit = 100;

function withReactionSnapshot(message: ChannelMessage, snapshot: MessageReactionSnapshot): ChannelMessage {
  return { ...message, reactions: { revision: snapshot.revision, counts: snapshot.counts } };
}

/** One room's history under its current binding: the confirmed window, its paging facts, removal markers and the
 * pages being assembled for pending requests. Pure state; the session correlates requests and performs effects. */
export class RoomHistory {
  private window?: ChannelMessage[];
  private info?: HistoryPaging;
  private markers?: RoomHistoryChanges;
  private readonly pages = new Map<string, PendingPage>();

  get messages(): ChannelMessage[] | undefined { return this.window; }
  get paging(): HistoryPaging | undefined { return this.info; }
  get changes(): RoomHistoryChanges | undefined { return this.markers; }

  /** Starts assembling the page a history request asks for. */
  openPage(requestId: string, { bindingId, before, replace, refresh, latestThrough }: Pick<PendingPage, "bindingId" | "before" | "replace" | "refresh" | "latestThrough">): void {
    this.pages.set(requestId, { bindingId, before, replace, refresh, entries: new Map(), ...(before === undefined && { latestThrough }),
      window: refresh?.window ?? (before !== undefined && !replace ? this.window ?? [] : []) });
  }
  hasPage(requestId: string): boolean { return this.pages.has(requestId); }
  /** Retires a page with its request. */
  dropPage(requestId: string): void { this.pages.delete(requestId); }
  /** Forgets the window and its paging facts; removal markers outlive the reading. */
  resetWindow(): void { this.window = undefined; this.info = undefined; }

  /** The message as this room shows it, or undefined when a removal marker covers it. */
  visible(message: ChannelMessage): ChannelMessage | undefined {
    return messageRemoved(this.markers, message.seq) ? undefined : redactReply(message, this.markers);
  }

  /** Records removals in the markers, window and pages; returns which sequences were removed. */
  remove(throughSeq: number, messageSeqs: number[], limit: number): (seq: number) => boolean {
    const previous = this.markers;
    const clearedThrough = Math.max(previous?.clearedThrough ?? 0, throughSeq);
    const deleted = new Set([...(previous?.deleted ?? []), ...messageSeqs].filter(seq => seq > clearedThrough));
    // These markers cover live events and overlapping pages. History storage owns older deletions.
    while (deleted.size > limit) deleted.delete(deleted.values().next().value!);
    const changes = this.markers = { clearedThrough, deleted };
    const removedSeqs = new Set(messageSeqs);
    const removed = (seq: number) => seq <= throughSeq || removedSeqs.has(seq);
    const remaining = (rows: ChannelMessage[]) => rows.filter(message => !removed(message.seq)).map(message => redactReply(message, changes));
    for (const page of this.pages.values()) page.window = remaining(page.window);
    const messages = this.window = remaining(this.window ?? []);
    const history = this.info;
    if (history) this.info = { ...history, hasMore: history.hasMore && (history.before ?? 0) > clearedThrough + 1,
      before: messages[0]?.seq ?? history.before };
    return removed;
  }

  /** Applies a reaction snapshot; returns the requests whose pages it proves incomplete. */
  applyReactions(bindingId: string, snapshot: MessageReactionSnapshot): string[] {
    const project = (messages: ChannelMessage[]) => {
      const index = messages.findIndex(message => message.id === snapshot.messageId && message.seq === snapshot.messageSeq);
      if (index < 0 || (messages[index].reactions?.revision ?? -1) >= snapshot.revision) return messages;
      return messages.with(index, withReactionSnapshot(messages[index], snapshot));
    };
    const incomplete: string[] = [];
    for (const [requestId, page] of this.pages) {
      if (page.bindingId !== bindingId) continue;
      page.window = project(page.window);
      if (page.before !== undefined && snapshot.messageSeq >= page.before) continue;
      const entries = page.entries, entry = entries.get(snapshot.messageSeq);
      if ((!entry && entries.size >= pageEntryLimit) || (entry?.message && entry.message.id !== snapshot.messageId)) {
        incomplete.push(requestId);
        continue;
      }
      if (!entry?.snapshot || entry.snapshot.revision < snapshot.revision) entries.set(snapshot.messageSeq, { ...entry, snapshot });
    }
    if (this.window) this.window = project(this.window);
    return incomplete;
  }

  /** Adds a history_message to its page; false when the page is missing or cannot hold it. */
  addMessage(requestId: string, message: ChannelMessage): boolean {
    const entries = this.pages.get(requestId)?.entries, entry = entries?.get(message.seq);
    if (!entries || entry?.message || (!entry && entries.size >= pageEntryLimit)
      || (entry?.snapshot && entry.snapshot.messageId !== message.id)) return false;
    entries.set(message.seq, { ...entry, message });
    return true;
  }

  /** Assembles a page from its end record; undefined when its records do not match. */
  completePage(requestId: string, end: HistoryEnd): CompletedPage | undefined {
    const page = this.pages.get(requestId);
    const entries = page ? [...page.entries.values()].filter(entry => entry.message) : [];
    if (!page || end.count !== entries.length || entries.some(entry => !entry.snapshot)) return undefined;
    const rows = entries.map(({ message, snapshot }) => withReactionSnapshot(message!, snapshot!)).sort((a, b) => a.seq - b.seq);
    const current = this.window ?? [];
    let missing: number[] = [];
    if (page.refresh) {
      // Only this page's covered range can establish which cached messages were removed.
      const lower = end.hasMore ? rows[0]?.seq ?? Infinity : 0;
      const refreshThrough = page.before === undefined ? page.refresh.through : page.before - 1;
      const present = new Set(rows.map(message => message.seq));
      missing = current.filter(message => message.seq >= lower && message.seq <= refreshThrough && !present.has(message.seq)).map(message => message.seq);
    }
    return { missing, page, rows, current, end };
  }

  /** Merges a completed page into the window; false when the window is left unchanged. */
  mergePage({ page: request, rows: page, current, end: result }: CompletedPage, historyWindow: number): boolean {
    const { replace: jumping, refresh } = request;
    const last = page.at(-1)?.seq ?? 0;
    const latest = refresh?.latest ?? (result.before === null);
    const existing = result.before === null ? request.window.filter(message => message.seq > last) : request.window;
    const changes = this.markers;
    const projected = page.filter(message => !messageRemoved(changes, message.seq))
      .map(message => mergeMessage(current.find(previous => previous.id === message.id), redactReply(message, changes)));
    // A jump requests the page ending at its target. A failed jump keeps the reader's current window.
    if (jumping && !refresh && result.before !== null && projected.at(-1)?.seq !== result.before - 1) return false;
    const arrivals = refresh?.latest ? current.filter(message => message.seq > refresh.through) : [];
    const merged = mergeMessages([...existing, ...projected, ...arrivals].filter(message => !messageRemoved(changes, message.seq)
      && (!refresh || latest || message.seq >= refresh.from)
      && (result.oldestSeq === null || message.seq >= result.oldestSeq)).map(message => redactReply(message, changes)));
    const messages = readingWindow(merged, historyWindow, latest || !!refresh);
    if (refresh) {
      const first = page[0]?.seq;
      // The writer may split the selected window over several record- or byte-limited pages.
      refresh.before = result.hasMore && first !== undefined && first > refresh.from
        && (request.before === undefined || first < request.before) && messages.length === merged.length
        && messages.length < historyWindow ? first : undefined;
      if (refresh.before !== undefined) {
        refresh.window = messages;
        return false;
      }
    }
    const atLatest = latest || (!jumping && (this.info?.atLatest ?? true)
      && messages.at(-1)?.id === current.at(-1)?.id);
    const oldestSeq = result.oldestSeq;
    const canReadEarlier = !changes?.clearedThrough || (messages[0]?.seq ?? result.before ?? 0) > changes.clearedThrough + 1;
    const hasMore = canReadEarlier && (result.hasMore || (latest && request.clipped === true)
      || oldestSeq !== null && messages.length > 0 && messages[0].seq > oldestSeq);
    this.window = messages;
    this.info = { hasMore, before: messages[0]?.seq, atLatest,
      ...(latest && request.latestThrough !== undefined && !result.hasMore && !page.length && !messages.length && { emptyThrough: request.latestThrough }) };
    return true;
  }

  /** Adds a confirmed message to the pages under assembly and, when following the latest, to the window; false when the window is unchanged. */
  receiveMessage(message: ChannelMessage, live: boolean, historyWindow: number): boolean {
    const history = this.info;
    const messages = this.window ?? [];
    // A replayed confirmation can finish a send for a message preceding this reading window.
    if (!live && history?.hasMore && messages.length && message.seq < messages[0].seq) return false;
    let projected: ChannelMessage = { ...message, reactions: { revision: 0, counts: {} } };
    for (const page of this.pages.values()) {
      const snapshot = page.entries.get(message.seq)?.snapshot;
      if (snapshot?.messageId === message.id) projected = mergeMessage(projected,
        withReactionSnapshot(message, snapshot));
      if (page.replace || (page.before !== undefined && history?.atLatest === false)) continue;
      const merged = mergeMessages([...page.window, projected]);
      page.window = readingWindow(merged, historyWindow, page.before === undefined);
      if (page.window.length < merged.length) page.clipped = true;
    }
    if (history?.atLatest === false) return false;
    const merged = mergeMessages([...messages, projected]);
    const retained = this.window = readingWindow(merged, historyWindow, true);
    if (history && retained.length < merged.length) this.info = { ...history, before: retained[0]?.seq, hasMore: true };
    return true;
  }
}
