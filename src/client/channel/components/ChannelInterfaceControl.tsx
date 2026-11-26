import { useId } from "react";
import { Btn, Chip } from "../../components/living/primitives";
import { useCopy, type Copy } from "../../ui/copy";
import type { RoomLayout } from "../../lib/room-preferences";
import "./channel-interface-control.css";

const interfaceOptions = (t: Copy["t"]) => [
  { value: "full", label: t("channel.interfaceControl.full"),
    description: t("channel.interfaceControl.fullDescription") },
  { value: "minimal", label: t("channel.interfaceControl.minimal"),
    description: t("channel.interfaceControl.minimalDescription") },
] as const;

/** Presentation only; the caller owns whether this choice is saved or previewed. */
export function ChannelInterfaceControl({ value, onChange }: {
  value: RoomLayout; onChange(value: RoomLayout): void;
}) {
  const { t } = useCopy();
  const labelId = useId();
  return <div className="c3-interface-choice">
    <span id={labelId}>{t("channel.interfaceControl.interface")}</span>
    <div className="lr-toggle" role="group" aria-labelledby={labelId}>
      {interfaceOptions(t).map(option => <button key={option.value} type="button" title={option.description}
        className={value === option.value ? "is-selected" : undefined} aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}><span>{option.label}</span></button>)}
    </div>
  </div>;
}

/** An optional first-use choice; creation and personal preference stay with the page. */
export function ChannelInterfaceSuggestion({ value, onChange, onDismiss }: {
  value: RoomLayout; onChange(value: RoomLayout): void; onDismiss(): void;
}) {
  const { t } = useCopy();
  const headingId = useId();
  return <section className="c3-interface-suggestion" aria-labelledby={headingId}>
    <h3 id={headingId}>{t("channel.interfaceControl.chooseYourView")}</h3>
    <div className="c3-interface-options" role="group" aria-labelledby={headingId}>
      {interfaceOptions(t).map(option => <Chip key={option.value} selected={value === option.value}
        title={`${option.label}: ${option.description}`} onClick={() => onChange(option.value)}>
        <span className="c3-interface-option-label">{option.label}{option.value === "full" && <small>{t("channel.interfaceControl.default")}</small>}</span>
        <span className="c3-interface-option-description">{option.description}</span>
      </Chip>)}
    </div>
    <footer><Btn icon="arrowRight" size="dense" quiet title={{ text: t("channel.interfaceControl.skip") }}
      cap={{ text: t("channel.interfaceControl.skip") }} onClick={onDismiss} />
      <span>{t("channel.interfaceControl.changeLater")}</span>
    </footer>
  </section>;
}
