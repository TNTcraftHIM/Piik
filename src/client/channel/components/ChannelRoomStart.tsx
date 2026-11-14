import { ChannelIdentityMark } from "./ChannelIdentity";
import { useCopy } from "../../ui/copy";

export type ChannelEntry = { kind: "entry" | "site" };

/** A room's quiet beginning; navigation and creation remain with their existing owners. */
export function ChannelRoomStart({ icon = "couch", entry, canSend }: {
  icon?: string; entry?: ChannelEntry; canSend: boolean;
}) {
  const { t } = useCopy();
  const title = entry?.kind === "entry" ? t("channel.roomStart.welcome")
    : entry ? t("channel.roomStart.noRoomsYet") : t("channel.roomStart.noMessagesYet");
  const note = entry?.kind === "entry" ? t("channel.roomStart.entryHint")
    : entry ? t("channel.roomStart.createHint")
    : canSend ? t("channel.roomStart.sayHello") : "";
  return <div className={`c3-room-start is-empty${entry ? " is-entry" : ""}`}>
    <span className="c3-room-start-mark"><ChannelIdentityMark icon={icon} size={38} /></span>
    <div><h3>{title}</h3>{note && <p>{note}</p>}</div>
  </div>;
}
