import { useSyncExternalStore } from "react";
import { CHAT_HISTORY_LIMIT, RoomInteractionSession } from "../../lib/room-interactions";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import { RoomChatOverlaySettings } from "./RoomChatOverlay";
import { Tooltip } from "./Tooltip";

export function RoomChatSettings({ session }: { session: RoomInteractionSession }) {
  const { messages } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  return <div className="lr-floating-scroll lr-interaction-settings lr-chat-settings">
    {!vis && <p>{t("interaction.settingsHint")}</p>}
    <RoomChatOverlaySettings session={session} />
    <div className="lr-chat-export">
      {!vis && <p>{t("interaction.ephemeral")}</p>}
      <Tooltip kind="hint-chat-export" text={vis ? undefined : t("interaction.exportLimit", { count: String(CHAT_HISTORY_LIMIT) })}>
      <Btn icon="save" title="interaction.export" cap="interaction.export" disabled={!messages.length} onClick={() => {
          downloadBlob(new Blob([formatChatTranscript(messages)], { type: "text/plain;charset=utf-8" }),
            `piik-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
        }} />
      </Tooltip>
    </div>
  </div>;
}
