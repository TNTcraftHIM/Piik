import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { REACTION_IDS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useSurfaceDocument } from "../../ui/panel-window";
import { ReactionIcon } from "../../components/living/RoomReaction";
import { Tooltip } from "../../components/living/Tooltip";
import { RoomReactionGrid } from "../../components/living/RoomReactionPicker";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { downloadBlob } from "../../lib/download";
import { fileSize } from "../attachments";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignAvatar } from "./DesignAvatar";
import { DesignArtwork } from "./DesignArtwork";
import { DesignIdentityMark } from "./DesignIdentityPicker";
import { designPeople, type DesignCopy, type DesignRoom } from "./fixtures";

interface DesignFile { id: string; file: File }
interface DesignMessage { id: string; text: string; files: DesignFile[] }
type MessageReactionSelection = Partial<Record<ReactionId, boolean>>;
interface DesignConversationRoom {
  messages: DesignMessage[];
  draft: string;
  files: DesignFile[];
  reactions: Record<string, MessageReactionSelection>;
}
const emptyRoom: DesignConversationRoom = { messages: [], draft: "", files: [], reactions: {} };

/** One prototype conversation owner, shared by the room and its floating view. */
export function useDesignConversation() {
  const [rooms, setRooms] = useState<Record<string, DesignConversationRoom>>({});
  function updateRoom(roomId: string, update: (room: DesignConversationRoom) => DesignConversationRoom) {
    setRooms(previous => ({ ...previous, [roomId]: update(previous[roomId] ?? emptyRoom) }));
  }
  return {
    rooms,
    setDraft: (roomId: string, draft: string) => updateRoom(roomId, room => ({ ...room, draft })),
    addFiles: (roomId: string, files: File[]) => {
      const incoming = files.map(file => ({ id: crypto.randomUUID(), file }));
      updateRoom(roomId, room => ({ ...room, files: [...room.files, ...incoming] }));
    },
    removeFile: (roomId: string, fileId: string) => updateRoom(roomId, room => ({
      ...room, files: room.files.filter(file => file.id !== fileId),
    })),
    send: (roomId: string) => {
      const id = crypto.randomUUID();
      updateRoom(roomId, room => !room.draft.trim() && !room.files.length ? room : ({
        ...room, draft: "", files: [],
        messages: [...room.messages, { id, text: room.draft.trim(), files: room.files }],
      }));
    },
    toggleReaction: (roomId: string, messageId: string, reaction: ReactionId) => updateRoom(roomId, room => ({
      ...room, reactions: { ...room.reactions, [messageId]: {
        ...room.reactions[messageId], [reaction]: !room.reactions[messageId]?.[reaction],
      } },
    })),
  };
}
export type DesignConversationModel = ReturnType<typeof useDesignConversation>;

const messageReactionIds = REACTION_IDS.filter(id => !isThrow(id));

function MessageReactions({ copy, selected, toggle, initialLaugh = false }: {
  copy: DesignCopy; selected: MessageReactionSelection; toggle: (reaction: ReactionId) => void; initialLaugh?: boolean;
}) {
  const { t } = useCopy();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useAnchoredPopover(trigger, menu, { side: "above", align: "center" });
  const visible = messageReactionIds.filter(reaction => selected[reaction] || (initialLaugh && reaction === "laugh"));
  return <div className="cd-message-reactions">
    {visible.map(reaction => <button key={reaction} className="cd-reaction" type="button" aria-label={t(`interaction.reaction.${reaction}`)}
      aria-pressed={!!selected[reaction]} onClick={() => toggle(reaction)}>
      <ReactionIcon reaction={reaction} /><span>{(initialLaugh && reaction === "laugh" ? 2 : 0) + (selected[reaction] ? 1 : 0)}</span>
    </button>)}
    <Tooltip kind="hint-reaction-picker" className="cd-message-action" text={copy("回应这条消息", "React to this message")}>
      <button ref={trigger} popoverTarget={id} className="cd-add-reaction" type="button" aria-label={copy("回应这条消息", "React to this message")}>
        <Glyph name="smile" size={16} /><Glyph name="plus" size={10} />
      </button>
    </Tooltip>
    <div ref={menu} id={id} popover="auto" className="lr-floating-surface cd-message-reaction-menu" aria-label={copy("消息表情", "Message reactions")}>
      <strong>{copy("回应这条消息", "React to this message")}</strong>
      <RoomReactionGrid person={{ peerId: designPeople[3].id, displayName: copy("你", "You") }} selfPeerId={designPeople[3].id}
        reactionIds={messageReactionIds} canSend onSend={reaction => { toggle(reaction); menu.current?.hidePopover(); }} />
    </div>
  </div>;
}

function LocalAttachment({ entry, copy, onRemove }: { entry: DesignFile; copy: DesignCopy; onRemove?: () => void }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    if (!entry.file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(entry.file);
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [entry.file]);
  return <div className={"cd-local-file" + (onRemove ? " is-draft" : "") + (image ? " has-image" : "")}>
    {image ? <img src={image} alt={entry.file.name} onError={() => setImage(undefined)} /> : <Glyph name="save" size={22} />}
    <span><strong>{entry.file.name}</strong><small>{fileSize(entry.file.size)}</small></span>
    <ChannelAction icon={onRemove ? "x" : "arrowDown"} label={onRemove ? copy("移除文件", "Remove file") : copy("下载文件", "Download file")}
      iconOnly quiet hint={onRemove ? "hint-close" : "hint-details"}
      onClick={onRemove ?? (() => downloadBlob(entry.file, entry.file.name))} />
  </div>;
}

function Message({ index, time, children, copy, initialLaugh, model, roomId, messageId }: {
  index: number; time: string; children: ReactNode; copy: DesignCopy; initialLaugh?: boolean;
  model: DesignConversationModel; roomId: string; messageId: string;
}) {
  const person = designPeople[index];
  return <article className="cd-message">
    <DesignAvatar index={index} />
    <div><header><strong>{copy(person.name, person.english)}</strong><time>{time}</time></header>
      {children}<MessageReactions copy={copy} initialLaugh={initialLaugh}
        selected={model.rooms[roomId]?.reactions[messageId] ?? {}}
        toggle={reaction => model.toggleReaction(roomId, messageId, reaction)} />
    </div>
  </article>;
}

/** Drafts and dropped files stay in their room; this design surface sends no network requests. */
export function DesignConversation({ room, roomName, showingScreens, copy, model, compact = false }: {
  room: DesignRoom; roomName: string; showingScreens: boolean; copy: DesignCopy;
  model: DesignConversationModel; compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const surfaceDocument = useSurfaceDocument();
  const reading = useRef({ roomId: room.id, position: 0, following: true });
  const chooser = useRef<HTMLInputElement>(null);
  const { messages, draft, files } = model.rooms[room.id] ?? emptyRoom;
  const demoRoom = room.id === "games";
  useLayoutEffect(() => {
    if (reading.current.roomId !== room.id) reading.current = { roomId: room.id, position: 0, following: true };
    const node = log.current;
    if (!node) return;
    const { position, following } = reading.current;
    const restore = () => { node.scrollTop = following ? node.scrollHeight : position; };
    restore();
    // Adoption hides the native popover until its shell's layout effect reopens it.
    const view = node.ownerDocument.defaultView;
    const frame = view?.requestAnimationFrame(restore);
    return () => { if (frame !== undefined) view?.cancelAnimationFrame(frame); };
  }, [messages.length, room.id, surfaceDocument]);
  function addFiles(incoming: File[]) {
    model.addFiles(room.id, incoming);
  }
  return <section className={"cd-chat" + (compact ? " is-compact" : "")} aria-label={copy("聊天与附件", "Conversation and attachments")}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles([...event.dataTransfer.files]); }}>
    <div className="cd-conversation" ref={log} role="log" aria-label={copy("聊天记录", "Conversation")}
      onScroll={event => {
        const node = event.currentTarget;
        reading.current = { roomId: room.id, position: node.scrollTop,
          following: node.scrollHeight - node.scrollTop - node.clientHeight < 40 };
      }}>
      {!compact && !showingScreens && <div className="cd-room-welcome">
        <span className="cd-welcome-icon"><DesignIdentityMark value={room} size={33} /></span>
        <div><h3>{demoRoom ? copy("今晚，再来一局。", "One more round?") : roomName}</h3><p>{copy("有空就来，随时开聊。", "Drop in whenever. Stay a little longer.")}</p></div>
      </div>}
      {demoRoom && <>
        <div className="cd-date"><span>{copy("今天", "Today")}</span></div>
        <Message model={model} roomId={room.id} messageId="fixture-arrival" index={0} time="20:42" copy={copy}><p>{copy("都到齐了吗？就差一个人了。", "Everyone here? We need one more.")}</p></Message>
        <Message model={model} roomId={room.id} messageId="fixture-jump" index={1} time="20:43" copy={copy}>
          <p>{copy("来了。这次绝对不跳空。", "Here. Definitely making that jump this time.")}</p>
          {!compact && !showingScreens && <div className="cd-inline-preview"><DesignArtwork /><span><Glyph name="gamepad" size={16} />{copy("今晚的目标：过第一关", "Tonight's ambition: finish level one")}</span></div>}
        </Message>
        <Message model={model} roomId={room.id} messageId="fixture-highlight" index={2} time="20:44" copy={copy} initialLaugh><p>{copy("这句话我截图了。", "Saving this for the highlight reel.")}</p></Message>
      </>}
      {messages.map(message => <Message model={model} roomId={room.id} messageId={message.id} key={message.id} index={3} time={copy("刚刚", "Just now")} copy={copy}>
        {message.text && <p>{message.text}</p>}
        {message.files.map(entry => <LocalAttachment key={entry.id} entry={entry} copy={copy} />)}
      </Message>)}
    </div>
    {files.length > 0 && <div className="cd-draft-files" aria-label={copy("待发送附件", "Attachments to send")}>{files.map(entry =>
      <LocalAttachment key={entry.id} entry={entry} copy={copy} onRemove={() => model.removeFile(room.id, entry.id)} />
    )}</div>}
    <form className="cd-composer" onSubmit={event => {
      event.preventDefault();
      model.send(room.id);
    }}>
      <input ref={chooser} type="file" multiple hidden aria-label={copy("添加图片或文件", "Add images or files")}
        onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
      <ChannelAction icon="plus" label={copy("添加图片或文件", "Add images or files")} iconOnly quiet hint="hint-details" onClick={() => chooser.current?.click()} />
      <input aria-label={copy("发送消息", "Message")} value={draft} onChange={event => model.setDraft(room.id, event.target.value)}
        onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        placeholder={copy("聊点什么，", "Message ") + roomName + "…"} />
      <ChannelAction icon="send" label={copy("发送", "Send")} hint="hint-chat-send" iconOnly quiet type="submit" disabled={!draft.trim() && !files.length} />
    </form>
    {dragging && <div className="cd-file-drop"><Glyph name="arrowUp" size={30} /><strong>{copy("放开，添加到消息", "Drop to attach")}</strong><span>{copy("图片和文件都可以", "Images and files are welcome")}</span></div>}
  </section>;
}
