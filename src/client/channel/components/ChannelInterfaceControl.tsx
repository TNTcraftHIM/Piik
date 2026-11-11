import { useCopy } from "../../ui/copy";
import type { RoomPreferences } from "../../lib/room-preferences";
import "./channel-interface-control.css";

/** Presentation only; the caller owns whether this choice is saved or previewed. */
export function ChannelInterfaceControl({ value, onChange }: {
  value: RoomPreferences["interfaceLayout"]; onChange(value: RoomPreferences["interfaceLayout"]): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  return <label className="c3-interface-choice">
    <span>{zh ? "界面" : "Interface"}</span>
    <select className="lr-select" value={value} onChange={event => onChange(event.target.value as RoomPreferences["interfaceLayout"])}>
      <option value="workspace">{zh ? "完整工作区" : "Full workspace"}</option>
      <option value="quick">{zh ? "极简分享" : "Simple sharing"}</option>
    </select>
  </label>;
}
