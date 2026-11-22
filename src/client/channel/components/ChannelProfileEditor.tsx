import { useId, useRef, useState, type CSSProperties } from "react";
import { Btn } from "../../components/living/primitives";
import { PawnSvg } from "../../components/living/Pawn";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { ChannelIdentityImageInput } from "./ChannelIdentity";
import { MAX_USER_NAME_UNITS } from "../protocol";
import { channelErrorPresentation } from "../error-presentation";
import { useSettingsAction } from "./ChannelSettingsDialog";
import "./channel-profile-editor.css";

export function ChannelProfileEditor({ name, avatar, color, disabled, busy, onSave }: {
  name: string; avatar: string | null; color: string; disabled: boolean; busy: boolean;
  onSave(profile: { name?: string; avatar?: string | null }): Promise<void>;
}) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [nameDraft, setDraft] = useState<string>(), [pictureDraft, setPicture] = useState<string | null>();
  const draft = nameDraft ?? name;
  const picture = pictureDraft === undefined ? avatar : pictureDraft;
  const [preparing, setPreparing] = useState(false);
  const { error, run } = useSettingsAction(open);
  useAnchoredPopover(trigger, panel, { side: "above" });
  const close = () => { setPreparing(false); panel.current?.hidePopover(); };
  const locked = disabled || busy || preparing;
  const { message } = channelErrorPresentation(error, t);
  return <>
    <span ref={trigger} className="c3-profile-editor"><Btn icon="pencil" title={{ text: t("channel.profileEditor.editProfile") }}
      hint="hint-rename" size="dense" quiet disabled={disabled} popoverTarget={id} controls={id} expanded={open} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("channel.profileEditor.editProfile")}
      className="lr-anchored-card c3-name-popover" onBeforeToggle={event => {
        if (event.target !== event.currentTarget) return;
        if (event.newState === "closed" && event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement))
          trigger.current?.querySelector("button")?.focus({ preventScroll: true });
      }} onToggle={event => {
        if (event.target !== event.currentTarget) return;
        const opened = event.newState === "open";
        setOpen(opened);
        if (opened) { setDraft(undefined); setPicture(undefined); input.current?.focus({ preventScroll: true }); }
        else setPreparing(false);
      }}>
      <h2>{t("channel.profileEditor.editProfile")}</h2>
      <form onSubmit={event => {
        event.preventDefault();
        if (!draft.trim() || locked) return;
        if (nameDraft === undefined && pictureDraft === undefined) { close(); return; }
        void run(() => onSave({ name: nameDraft?.trim(), avatar: pictureDraft }), close);
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        {open && <div className="c3-profile-picture" style={{ "--profile-color": color } as CSSProperties}>
          <ChannelIdentityImageInput value={picture} onChange={setPicture} disabled={disabled || busy}
            busy={preparing} onBusyChange={setPreparing}
            fallbackPreview={<span className="c3-profile-pawn"><PawnSvg color={color} /></span>} />
        </div>}
        <label htmlFor={`${id}-name`}>{t("channel.profileEditor.nickname")}</label>
        <span className="lr-input"><input ref={input} id={`${id}-name`} maxLength={MAX_USER_NAME_UNITS} autoComplete="nickname"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled || busy} /></span>
        {message && <p className="c3-settings-error" role="alert">{message}</p>}
        <div className="c3-profile-actions">
          <Btn icon="x" size="dense" quiet title="common.cancel" cap="common.cancel" onClick={close} />
          <Btn icon="check" type="submit" size="dense" tone="primary" title={{ text: t("channel.profileEditor.saveProfile") }}
            cap={{ text: t("channel.profileEditor.saveProfile") }} busy={busy} disabled={locked || !draft.trim()} />
        </div>
      </form>
    </div>
  </>;
}
