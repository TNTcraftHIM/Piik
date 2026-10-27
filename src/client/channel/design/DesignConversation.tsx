import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { REACTION_IDS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
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
const messageReactionIds = REACTION_IDS.filter(id => !isThrow(id));

function MessageReactions({ copy, initialLaugh = false }: { copy: DesignCopy; initialLaugh?: boolean }) {
  const { t } = useCopy();
  const [selected, setSelected] = useState<Partial<Record<ReactionId, boolean>>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useAnchoredPopover(trigger, menu, { side: "above", align: "center" });
  const toggle = (reaction: ReactionId) => setSelected(previous => ({ ...previous, [reaction]: !previous[reaction] }));
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

function Message({ index, time, children, copy, initialLaugh }: {
  index: number; time: string; children: ReactNode; copy: DesignCopy; initialLaugh?: boolean;
}) {
  const person = designPeople[index];
  return <article className="cd-message">
    <DesignAvatar index={index} />
    <div><header><strong>{copy(person.name, person.english)}</strong><time>{time}</time></header>
      {children}<MessageReactions copy={copy} initialLaugh={initialLaugh} />
    </div>
  </article>;
}

/** Drafts and dropped files stay in their room; this design surface sends no network requests. */
export function DesignConversation({ room, roomName, showingScreens, copy }: {
  room: DesignRoom; roomName: string; showingScreens: boolean; copy: DesignCopy;
}) {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, DesignMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filesByRoom, setFilesByRoom] = useState<Record<string, DesignFile[]>>({});
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const messages = messagesByRoom[room.id] ?? [];
  const draft = drafts[room.id] ?? "";
  const files = filesByRoom[room.id] ?? [];
  const demoRoom = room.id === "games";
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages.length, room.id]);
  function addFiles(incoming: File[]) {
    setFilesByRoom(previous => ({ ...previous, [room.id]: [...(previous[room.id] ?? []), ...incoming.map(file => ({ id: crypto.randomUUID(), file }))] }));
  }
  return <section className="cd-chat" aria-label={copy("聊天与附件", "Conversation and attachments")}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles([...event.dataTransfer.files]); }}>
    <div className="cd-conversation" ref={log} role="log" aria-label={copy("聊天记录", "Conversation")}>
      {!showingScreens && <div className="cd-room-welcome">
        <span className="cd-welcome-icon"><DesignIdentityMark value={room} size={33} /></span>
        <div><h3>{demoRoom ? copy("今晚，再来一局。", "One more round?") : roomName}</h3><p>{copy("有空就来，随时开聊。", "Drop in whenever. Stay a little longer.")}</p></div>
      </div>}
      {demoRoom && <>
        <div className="cd-date"><span>{copy("今天", "Today")}</span></div>
        <Message index={0} time="20:42" copy={copy}><p>{copy("都到齐了吗？就差一个人了。", "Everyone here? We need one more.")}</p></Message>
        <Message index={1} time="20:43" copy={copy}>
          <p>{copy("来了。这次绝对不跳空。", "Here. Definitely making that jump this time.")}</p>
          {!showingScreens && <div className="cd-inline-preview"><DesignArtwork /><span><Glyph name="gamepad" size={16} />{copy("今晚的目标：过第一关", "Tonight's ambition: finish level one")}</span></div>}
        </Message>
        <Message index={2} time="20:44" copy={copy} initialLaugh><p>{copy("这句话我截图了。", "Saving this for the highlight reel.")}</p></Message>
      </>}
      {messages.map(message => <Message key={message.id} index={3} time={copy("刚刚", "Just now")} copy={copy}>
        {message.text && <p>{message.text}</p>}
        {message.files.map(entry => <LocalAttachment key={entry.id} entry={entry} copy={copy} />)}
      </Message>)}
    </div>
    {files.length > 0 && <div className="cd-draft-files" aria-label={copy("待发送附件", "Attachments to send")}>{files.map(entry =>
      <LocalAttachment key={entry.id} entry={entry} copy={copy} onRemove={() => setFilesByRoom(previous => ({ ...previous, [room.id]: files.filter(file => file.id !== entry.id) }))} />
    )}</div>}
    <form className="cd-composer" onSubmit={event => {
      event.preventDefault();
      if (!draft.trim() && !files.length) return;
      setMessagesByRoom(previous => ({ ...previous, [room.id]: [...messages, { id: crypto.randomUUID(), text: draft.trim(), files }] }));
      setDrafts(previous => ({ ...previous, [room.id]: "" })); setFilesByRoom(previous => ({ ...previous, [room.id]: [] }));
    }}>
      <input ref={chooser} type="file" multiple hidden aria-label={copy("添加图片或文件", "Add images or files")}
        onChange={event => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
      <ChannelAction icon="plus" label={copy("添加图片或文件", "Add images or files")} iconOnly quiet hint="hint-details" onClick={() => chooser.current?.click()} />
      <input aria-label={copy("发送消息", "Message")} value={draft} onChange={event => setDrafts(previous => ({ ...previous, [room.id]: event.target.value }))}
        onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }}
        placeholder={copy("聊点什么，", "Message ") + roomName + "…"} />
      <ChannelAction icon="send" label={copy("发送", "Send")} hint="hint-chat-send" iconOnly quiet type="submit" disabled={!draft.trim() && !files.length} />
    </form>
    {dragging && <div className="cd-file-drop"><Glyph name="arrowUp" size={30} /><strong>{copy("放开，添加到消息", "Drop to attach")}</strong><span>{copy("图片和文件都可以", "Images and files are welcome")}</span></div>}
  </section>;
}
