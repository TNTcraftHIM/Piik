import { useState } from "react";
import { ChannelConversation } from "../components/ChannelConversation";
import { ChannelAttachments } from "../attachments";
import type { ChannelMessage, MessageReactions } from "../protocol";
import { designPeople, type DesignCopy } from "./fixtures";
import { setDesignMessageReaction } from "./DesignConversation";

const unavailable = async () => { throw new Error("visual_preview_only"); };

/** Sample data only; the conversation, empty state and composer are the real view. */
export function DesignSparseConversation({ roomId, roomName, people, few, copy }: {
  roomId: string; roomName: string; people: number[]; few: boolean; copy: DesignCopy;
}) {
  const [attachments] = useState(() => new ChannelAttachments(unavailable, unavailable));
  const users = people.map(index => ({ id: designPeople[index].id,
    name: copy(designPeople[index].name, designPeople[index].english), roles: [] }));
  const [started] = useState(Date.now);
  const [sent, setSent] = useState<ChannelMessage[]>([]);
  const [reactions, setReactions] = useState<Record<string, MessageReactions>>({});
  const samples: ChannelMessage[] = few ? [
    { id: "quiet-arrival", seq: 1, userId: users[0].id, time: started - 120_000,
      text: copy("先在这里待会儿。", "I'll be here for a little while."), attachments: [] },
    { id: "quiet-hello", seq: 2, userId: (users[1] ?? users[0]).id, time: started - 60_000,
      text: copy("待会儿见。", "See you in a bit."), attachments: [] },
  ] : [];
  const messages = [...samples, ...sent].map(message => ({ ...message, reactions: reactions[`${roomId}:${message.id}`] }));
  return <ChannelConversation roomId={roomId} roomName={roomName} messages={messages} users={users}
    selfUserId={designPeople[3].id} isReactionPending={() => false} onReaction={async (_room, seq, reaction, active) => {
      const message = messages.find(value => value.seq === seq);
      if (!message) return;
      const key = `${roomId}:${message.id}`;
      setReactions(previous => ({ ...previous, [key]: setDesignMessageReaction(previous[key], designPeople[3].id, reaction, active) }));
    }}
    entry={{ kind: "domain", canCreate: true }} canSend={!!roomId} sending={false} hidden={false}
    attachments={attachments} attachmentsAvailable={false} available={true}
    history={{ hasMore: false, atLatest: true }} loadingHistory={false}
    onHistory={unavailable} onLatest={unavailable} onSend={async (_room, text) => {
      setSent(previous => [...previous, { id: crypto.randomUUID(), seq: samples.length + previous.length + 1,
        userId: designPeople[3].id, text, time: Date.now(), attachments: [] }]);
    }} />;
}
