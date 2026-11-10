import { ChannelIdentityMark } from "./ChannelIdentity";
import { useCopy } from "../../ui/copy";

export type ChannelEntry = { kind: "entry" | "site" };

/** A room's quiet beginning; navigation and creation remain with their existing owners. */
export function ChannelRoomStart({ roomName, icon = "couch", entry, empty = true, canSend }: {
  roomName: string; icon?: string; entry?: ChannelEntry; empty?: boolean; canSend: boolean;
}) {
  const { lang, vis } = useCopy();
  const copy = (cn: string, en: string) => lang === "zh" ? cn : en;
  const title = entry?.kind === "entry" ? copy("一起待会儿。", "A place to be together.")
    : entry ? copy("还没有房间", "No rooms yet") : roomName;
  const note = entry?.kind === "entry" ? copy("打开朋友分享的站点或房间链接。", "Open a site or room link from a friend.")
    : entry ? copy("从房间列表创建第一间房间。", "Create your first room from the room list.")
    : canSend ? copy("还没有消息。打个招呼吧。", "No messages yet. Say hello.")
      : copy("还没有消息。", "No messages yet.");
  return <div className={`c3-room-start${empty ? " is-empty" : ""}${entry ? " is-entry" : ""}`}>
    <span className="c3-room-start-mark"><ChannelIdentityMark icon={icon} size={38} /></span>
    <div className={vis ? "visually-hidden" : undefined}><h3>{title}</h3>{empty && <p>{note}</p>}</div>
  </div>;
}
