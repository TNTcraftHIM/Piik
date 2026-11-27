import { useSyncExternalStore } from "react";
import { CHAT_HISTORY_LIMIT, RoomInteractionSession } from "../../lib/room-interactions";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";

export function RoomChatSettings({ session }: { session: RoomInteractionSession }) {
  const hasMessages = useSyncExternalStore(session.subscribe, () => session.getSnapshot().messages.length > 0);
  const { t } = useCopy();
  return <div className="lr-floating-scroll lr-interaction-settings lr-chat-settings">
    <div className="lr-chat-export">
      <p>{t("interaction.ephemeral")}</p>
      <Tooltip kind="hint-chat-export" text={t("interaction.exportLimit", { count: String(CHAT_HISTORY_LIMIT) })}>
      <Btn icon="save" title="interaction.export" cap="interaction.export" disabled={!hasMessages} onClick={() => {
          const { messages } = session.getSnapshot();
          downloadBlob(new Blob([formatChatTranscript(messages)], { type: "text/plain;charset=utf-8" }),
            `piik-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
        }} />
      </Tooltip>
    </div>
  </div>;
}
