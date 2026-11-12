import { useId } from "react";
import { Btn, Chip } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import type { InterfaceLayout } from "../../lib/room-preferences";
import "./channel-interface-control.css";

const interfaceOptions = (zh: boolean) => [
  { value: "workspace", label: zh ? "完整工作区" : "Full workspace",
    description: zh ? "房间、聊天和分享，一处掌握。" : "Rooms, chat and sharing together." },
  { value: "quick", label: zh ? "极简分享" : "Simple sharing",
    description: zh ? "把画面放在中心，随时开始分享。" : "Keep the picture central, ready to share." },
] as const;

/** Presentation only; the caller owns whether this choice is saved or previewed. */
export function ChannelInterfaceControl({ value, onChange }: {
  value: InterfaceLayout; onChange(value: InterfaceLayout): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  return <label className="c3-interface-choice">
    <span>{zh ? "界面" : "Interface"}</span>
    <select className="lr-select" value={value} onChange={event => onChange(event.target.value as InterfaceLayout)}>
      {interfaceOptions(zh).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

/** An optional first-use choice; creation and personal preference stay with the page. */
export function ChannelInterfaceSuggestion({ value, onChange, onDismiss }: {
  value: InterfaceLayout; onChange(value: InterfaceLayout): void; onDismiss(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const headingId = useId();
  return <section className="c3-interface-suggestion" aria-labelledby={headingId}>
    <h3 id={headingId}>{zh ? "选择适合你的界面" : "Choose your view"}</h3>
    <div className="c3-interface-options" role="group" aria-labelledby={headingId}>
      {interfaceOptions(zh).map(option => <Chip key={option.value} selected={value === option.value}
        title={`${option.label}: ${option.description}`} onClick={() => onChange(option.value)}>
        <span className="c3-interface-option-label">{option.label}{option.value === "workspace" && <small>{zh ? "默认" : "Default"}</small>}</span>
        <span className="c3-interface-option-description">{option.description}</span>
      </Chip>)}
    </div>
    <footer><Btn icon="arrowRight" size="dense" quiet title={{ text: zh ? "跳过" : "Skip" }}
      cap={{ text: zh ? "跳过" : "Skip" }} onClick={onDismiss} />
      <span>{zh ? "以后可在“更多选项 → 界面”中修改。" : "Change this later in More options → Interface."}</span>
    </footer>
  </section>;
}
