import { useId, useSyncExternalStore } from "react";
import { CHAT_HISTORY_LIMIT, CHAT_OVERLAY_LIMITS, RoomInteractionSession } from "../../lib/room-interactions";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";

export function RoomChatSettings({ session }: { session: RoomInteractionSession }) {
  const { overlayAppearance, messages } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const id = useId();
  return <div className="lr-chat-settings">
    {!vis && <p>{t("interaction.settingsHint")}</p>}
    {(["scale", "opacity"] as const).map(property => {
      const percent = Math.round(overlayAppearance[property] * 100);
      const label = t(`interaction.overlay.${property}`);
      return <div className="lr-chat-setting" key={property}>
        <label htmlFor={`${id}-${property}`}>
          {vis ? <Glyph name={property === "scale" ? "textSize" : "opacity"} size={18} /> : label}
          <output htmlFor={`${id}-${property}`}>{percent}%</output>
        </label>
        <Tooltip kind="hint-chat-settings" text={vis ? undefined : label}>
          <input id={`${id}-${property}`} type="range" min={CHAT_OVERLAY_LIMITS[property][0] * 100}
            max={CHAT_OVERLAY_LIMITS[property][1] * 100} step={10} value={percent}
            aria-label={label} aria-valuetext={`${percent}%`}
            onChange={event => session.setOverlayAppearance({ ...overlayAppearance, [property]: Number(event.target.value) / 100 })} />
        </Tooltip>
      </div>;
    })}
    <div className="lr-chat-export">
      <Btn icon="save" title="interaction.export" cap="interaction.export" hint="hint-chat-export"
        hintText="interaction.exportHint" disabled={!messages.length} onClick={() => {
          downloadBlob(new Blob([formatChatTranscript(messages)], { type: "text/plain;charset=utf-8" }),
            `piik-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
        }} />
      {!vis && <small>{t("interaction.exportLimit", { count: String(CHAT_HISTORY_LIMIT) })}</small>}
    </div>
  </div>;
}
