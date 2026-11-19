import type { ChannelMessage } from "./protocol";
import { messageRemoved, type RoomHistoryChanges } from "./types";

export function mergeMessages(messages: ChannelMessage[]): ChannelMessage[] {
  const merged = new Map<string, ChannelMessage>();
  for (const message of messages) merged.set(message.id, mergeMessage(merged.get(message.id), message));
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

export function mergeMessage(previous: ChannelMessage | undefined, message: ChannelMessage): ChannelMessage {
  return previous?.reactions && (!message.reactions || previous.reactions.revision > message.reactions.revision)
    ? { ...message, reactions: previous.reactions } : message;
}

export function redactReply(message: ChannelMessage, changes: RoomHistoryChanges | undefined): ChannelMessage {
  if (!message.reply || !messageRemoved(changes, message.reply.seq)) return message;
  const { reply: _reply, ...remaining } = message;
  return remaining;
}

const textEncoder = new TextEncoder();
const maxHistoryBytes = 4 * 1024 * 1024;
const messageBytes = new WeakMap<ChannelMessage, number>();

function encodedSize(message: ChannelMessage): number {
  let size = messageBytes.get(message);
  if (size === undefined) {
    size = textEncoder.encode(JSON.stringify(message)).length;
    messageBytes.set(message, size);
  }
  return size;
}

/** Keep a contiguous end of history within the message and byte limits. */
export function readingWindow(messages: ChannelMessage[], count: number, latest: boolean): ChannelMessage[] {
  let bytes = 0, kept = 0;
  for (let index = latest ? messages.length - 1 : 0; index >= 0 && index < messages.length && kept < count; index += latest ? -1 : 1) {
    const size = encodedSize(messages[index]);
    if (kept > 0 && bytes + size > maxHistoryBytes) break;
    bytes += size; kept++;
  }
  return latest ? messages.slice(messages.length - kept) : messages.slice(0, kept);
}

// Pages are replaced when history changes. Keep only IDs, so a profile refresh
// or a reconnect still reads the current display names and avatars.
const pageProfiles = new WeakMap<readonly ChannelMessage[], readonly string[]>();

export function historyProfileIds(messages: readonly ChannelMessage[]): readonly string[] {
  const cached = pageProfiles.get(messages);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const message of messages) {
    if (!message.archivedAuthorName) ids.add(message.userId);
    if (message.reply && !message.reply.archivedAuthorName) ids.add(message.reply.userId);
    for (const mention of message.mentions ?? []) ids.add(mention.userId);
  }
  const result = [...ids];
  pageProfiles.set(messages, result);
  return result;
}
