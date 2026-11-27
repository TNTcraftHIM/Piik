import { useId, useRef, useState, type CSSProperties } from "react";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { PawnSvg } from "../../components/living/Pawn";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Glyph } from "../../ui/icons";
import { useLayerHistory } from "../../ui/layer-history";
import { useCopy } from "../../ui/copy";
import { ChannelIdentityImageInput } from "./ChannelIdentity";
import { MAX_USER_NAME_UNITS, type ProfileUpdate } from "../protocol";
import { channelErrorPresentation } from "../../components/error-presentation";
import { useSettingsAction } from "../../ui/use-settings-action";
import "./channel-profile-editor.css";

export function ChannelProfileEditor({ name, avatar, color, disabled, profileReady, busy, onSave, userId, triggerStyle }: {
  userId: string; triggerStyle: "name" | "pencil" | "pawn";
  name: string; avatar: string | null; color: string; disabled: boolean; profileReady: boolean; busy: boolean;
  onSave(profile: ProfileUpdate): Promise<void>;
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
  useLayerHistory(panel, open);
  const close = () => panel.current?.hidePopover();
  const editable = !disabled && profileReady && !busy;
  const { message } = channelErrorPresentation(error, t);
  const editLabel = t("channel.profileEditor.editProfile");
  const hint = triggerStyle === "name"
    ? { text: editLabel, overflow: { text: name, selector: "strong" } }
    : { kind: "hint-rename" as const, text: editLabel };
  return <>
    <span ref={trigger} className="c3-profile-editor">
      <Tooltip {...hint} disabled={open}>
        <button type="button" className={"lr-btn is-dense is-quiet c3-profile-" + triggerStyle} disabled={disabled}
          aria-label={triggerStyle === "name" ? undefined : editLabel} aria-haspopup="dialog"
          popoverTarget={id} aria-controls={id} aria-expanded={open}>
          {triggerStyle === "name" ? <strong>{name}</strong> : triggerStyle === "pawn"
            ? <PawnSvg centered color={color} identity={userId} avatar={avatar ?? undefined} /> : <Glyph name="pencil" />}
        </button>
      </Tooltip>
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
      }}>
      <h2>{t("channel.profileEditor.editProfile")}</h2>
      <form onSubmit={event => {
        event.preventDefault();
        if (!draft.trim() || !editable || preparing) return;
        if (nameDraft === undefined && pictureDraft === undefined) { close(); return; }
        void run(() => onSave({ name: nameDraft?.trim(), avatar: pictureDraft }), close);
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        {open && <div className="c3-profile-picture" style={{ "--profile-color": color } as CSSProperties}>
          <ChannelIdentityImageInput value={picture} onChange={setPicture} disabled={!editable}
            busy={preparing} onBusyChange={setPreparing}
            fallbackPreview={<span className="c3-profile-preview"><PawnSvg color={color} /></span>} />
        </div>}
        <label htmlFor={`${id}-name`}>{t("channel.profileEditor.nickname")}</label>
        <span className="lr-input"><input ref={input} id={`${id}-name`} maxLength={MAX_USER_NAME_UNITS} autoComplete="nickname"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={!editable} /></span>
        {!disabled && !profileReady && <p className="c3-profile-status" role="status">{t("channel.profileEditor.waitingForProfile")}</p>}
        {message && <p className="c3-settings-error" role="alert">{message}</p>}
        <div className="c3-profile-actions">
          <Btn icon="x" size="dense" quiet title="common.cancel" cap="common.cancel" onClick={close} />
          <Btn icon="check" type="submit" size="dense" tone="primary" title={{ text: t("channel.profileEditor.saveProfile") }}
            cap={{ text: t("channel.profileEditor.saveProfile") }} busy={busy} disabled={!editable || preparing || !draft.trim()} />
        </div>
      </form>
    </div>
  </>;
}
