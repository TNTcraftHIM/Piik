import { useEffect, useRef, useState, type FormEvent } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelMessage, ChannelUser } from "../protocol";
import { ChannelAction } from "./ChannelMedia";

/** Browsing owns the conversation; drafts and reading position belong to this pane. */
export function ChannelConversation({ roomId, roomName, messages, users, canSend, sending, onSend, hidden }: {
  roomId: string; roomName: string; messages: ChannelMessage[]; users: ChannelUser[];
  canSend: boolean; sending: boolean; hidden: boolean;
  onSend: (roomId: string, text: string) => Promise<void>;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const draft = drafts[roomId] ?? "";
  useEffect(() => { follow.current = true; }, [roomId]);
  useEffect(() => {
    if (!hidden && follow.current) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [roomId, messages.length, hidden]);
  function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !canSend || sending) return;
    follow.current = true;
    void onSend(roomId, draft.trim()).then(() => {
      setDrafts(previous => previous[roomId] === draft ? { ...previous, [roomId]: "" } : previous);
    }).catch(() => {});
  }
  return <section id="c3-chat" className="c3-conversation" hidden={hidden} aria-label={zh ? "房间聊天" : "Room chat"}>
    <div className="c3-chat-heading"><Glyph name="chat" size={18} /><strong>{zh ? "聊天" : "Chat"}</strong>
      <span>{roomName}</span></div>
    <div className="c3-message-log" ref={log} role="log" aria-label={zh ? "消息" : "Messages"}
      onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
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
        return <article className={`c3-message${grouped ? " is-continuation" : ""}`} key={message.id}>
          {!grouped && <PawnSvg color={participantColor(message.userId)} identity={message.userId} />}
          <div className="c3-message-body">{!grouped && <div className="c3-message-meta"><strong>{name}</strong>
            <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
          </div>}<p>{message.text}</p></div>
        </article>;
      })}
    </div>
    <form className="c3-composer" onSubmit={send}>
      <textarea rows={1} maxLength={2000} aria-label={zh ? "消息内容" : "Message"} value={draft}
        placeholder={zh ? "说点什么…" : "Say something…"} disabled={!roomId}
        onChange={event => setDrafts(previous => ({ ...previous, [roomId]: event.target.value }))}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.currentTarget.form?.requestSubmit();
        } }} />
      <ChannelAction icon="send" label={zh ? "发送" : "Send"} type="submit" primary iconOnly
        disabled={!canSend || !draft.trim()} busy={sending} hint="hint-chat-send" />
    </form>
  </section>;
}
