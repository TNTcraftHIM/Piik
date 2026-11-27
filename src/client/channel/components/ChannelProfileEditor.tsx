import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
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
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import { memberName } from "../member-name";
import "./channel-profile-editor.css";

export function ChannelProfileEditor({ name, avatar, color, disabled, profileReady, busy, onSave, userId, siteId, askUnnamedMemberName, triggerStyle }: {
  userId: string; siteId?: string; askUnnamedMemberName: boolean; triggerStyle: "name" | "pencil" | "pawn";
  name: string; avatar: string | null; color: string; disabled: boolean; profileReady: boolean; busy: boolean;
  onSave(profile: ProfileUpdate): Promise<void>;
}) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const prompting = useRef(false), dismissed = useRef(false);
  const [open, setOpen] = useState(false), [nameDraft, setDraft] = useState<string>(), [pictureDraft, setPicture] = useState<string | null>();
  const draft = nameDraft ?? name;
  const picture = pictureDraft === undefined ? avatar : pictureDraft;
  const [preparing, setPreparing] = useState(false);
  const { error, run } = useSettingsAction(open);
  useAnchoredPopover(trigger, panel, { side: "above" });
  useLayerHistory(panel, open);
  const close = () => panel.current?.hidePopover();
  const editable = !disabled && profileReady && !busy;
  const identityKey = siteId ? JSON.stringify([siteId, userId]) : null;
  const canPrompt = askUnnamedMemberName && editable && !name;
  useEffect(() => {
    if (!canPrompt || !identityKey || prompting.current || dismissed.current ||
      readRoomPreferences().nicknamePromptDismissedByIdentity[identityKey]) return;
    const popover = panel.current, button = trigger.current?.querySelector("button");
    if (!popover || !button || popover.matches(":popover-open") || popover.ownerDocument.querySelector("dialog:modal")) return;
    prompting.current = true;
    popover.showPopover({ source: button });
  }, [canPrompt, identityKey]);
  const dismissPrompt = () => {
    if (!identityKey || dismissed.current) return;
    dismissed.current = true;
    saveRoomPreferences({ nicknamePromptDismissedByIdentity: {
      ...readRoomPreferences().nicknamePromptDismissedByIdentity, [identityKey]: true,
    } });
  };
  const { message } = channelErrorPresentation(error, t);
  const editLabel = t("channel.profileEditor.editProfile");
  const displayName = memberName(userId, name);
  const namePrompt = open && prompting.current;
  const heading = namePrompt ? t("channel.profileEditor.chooseNickname") : editLabel;
  const dismissLabel = namePrompt ? { text: t("channel.profileEditor.skipNickname") } : "common.cancel" as const;
  const hint = triggerStyle === "name"
    ? { text: editLabel, overflow: { text: displayName, selector: "strong" } }
    : { kind: "hint-rename" as const, text: editLabel };
  return <>
    <span ref={trigger} className="c3-profile-editor">
      <Tooltip {...hint} disabled={open}>
        <button type="button" className={"lr-btn is-dense is-quiet c3-profile-" + triggerStyle} disabled={disabled}
          aria-label={triggerStyle === "name" ? undefined : editLabel} aria-haspopup="dialog"
          popoverTarget={id} aria-controls={id} aria-expanded={open}>
          {triggerStyle === "name" ? <strong>{displayName}</strong> : triggerStyle === "pawn"
            ? <PawnSvg centered color={color} identity={userId} avatar={avatar ?? undefined} /> : <Glyph name="pencil" />}
        </button>
      </Tooltip>
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={heading}
      className="lr-anchored-card c3-name-popover" onBeforeToggle={event => {
        if (event.target !== event.currentTarget) return;
        if (event.newState !== "closed") return;
        if (prompting.current || (askUnnamedMemberName && !name)) dismissPrompt();
        prompting.current = false;
        if (event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement))
          trigger.current?.querySelector("button")?.focus({ preventScroll: true });
      }} onToggle={event => {
        if (event.target !== event.currentTarget) return;
        const opened = event.newState === "open";
        setOpen(opened);
        if (opened) { setDraft(undefined); setPicture(undefined); input.current?.focus({ preventScroll: true }); }
      }}>
      <h2>{heading}</h2>
      <form onSubmit={event => {
        event.preventDefault();
        if (!editable || preparing) return;
        const trimmed = draft.trim();
        const changedName = trimmed === name ? undefined : trimmed;
        if (changedName === undefined && pictureDraft === undefined) { close(); return; }
        void run(() => onSave({ name: changedName, avatar: pictureDraft }), () => {
          if (askUnnamedMemberName && !trimmed) dismissPrompt();
          close();
        });
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        {open && <div className="c3-profile-picture" style={{ "--profile-color": color } as CSSProperties}>
          <ChannelIdentityImageInput value={picture} onChange={setPicture} disabled={!editable}
            busy={preparing} onBusyChange={setPreparing}
            fallbackPreview={<span className="c3-profile-preview"><PawnSvg color={color} /></span>} />
        </div>}
        <label htmlFor={`${id}-name`}>{t("channel.profileEditor.nickname")}</label>
        <span className="lr-input"><input ref={input} id={`${id}-name`} name="nickname" maxLength={MAX_USER_NAME_UNITS} autoComplete="nickname"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={!editable} /></span>
        {!disabled && !profileReady && <p className="c3-profile-status" role="status">{t("channel.profileEditor.waitingForProfile")}</p>}
        {message && <p className="c3-settings-error" role="alert">{message}</p>}
        <div className="c3-profile-actions">
          <Btn icon="x" size="dense" quiet title={dismissLabel} cap={dismissLabel} onClick={close} />
          <Btn icon="check" type="submit" size="dense" tone="primary" title={{ text: t("channel.profileEditor.saveProfile") }}
            cap={{ text: t("channel.profileEditor.saveProfile") }} busy={busy} disabled={!editable || preparing} />
        </div>
      </form>
    </div>
  </>;
}
