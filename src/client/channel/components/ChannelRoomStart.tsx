import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

export type ChannelEntry = { kind: "entry" } | { kind: "domain"; canCreate: boolean };

/** A room's quiet beginning; navigation and creation remain with their existing owners. */
export function ChannelRoomStart({ roomName, entry, empty = true }: {
  roomName: string; entry?: ChannelEntry; empty?: boolean;
}) {
  const { lang, vis } = useCopy();
  const copy = (cn: string, en: string) => lang === "zh" ? cn : en;
  const title = entry?.kind === "entry" ? copy("一起待会儿。", "A place to be together.")
    : entry ? entry.canCreate ? copy("还没有房间", "No rooms yet")
      : copy("暂无可进入的房间", "No rooms available yet") : roomName;
  const note = entry?.kind === "entry" ? copy("打开朋友发来的邀请链接，进入他们的频道。", "Open an invitation from a friend to join their channel.")
    : entry ? entry.canCreate
      ? copy("从房间列表创建第一间房间。", "Create your first room from the room list.")
      : copy("可进入的房间会显示在房间列表中。", "Rooms you can enter will appear in the room list.")
    : copy("还没有消息。打个招呼吧。", "No messages yet. Say hello.");
  return <div className={`c3-room-start${empty ? " is-empty" : ""}${entry ? " is-entry" : ""}`}>
    <span className="c3-room-start-mark"><Glyph name="couch" size={38} /></span>
    {!vis && <div><h3>{title}</h3>{empty && <p>{note}</p>}</div>}
  </div>;
}
