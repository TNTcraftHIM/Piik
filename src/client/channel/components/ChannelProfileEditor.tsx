import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { PawnSvg } from "../../components/living/Pawn";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { prepareIdentityImage } from "../identity-image";
import { MAX_USER_NAME_UNITS } from "../protocol";
import { channelErrorPresentation } from "../error-presentation";
import { useSettingsAction } from "./ChannelSettingsDialog";
import "./channel-profile-editor.css";

export function ChannelProfileEditor({ name, avatar, color, disabled, busy, onSave }: {
  name: string; avatar: string | null; color: string; disabled: boolean; busy: boolean;
  onSave(profile: { name: string; avatar: string | null }): Promise<void>;
}) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null), preparation = useRef(0);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(name), [picture, setPicture] = useState(avatar);
  const [preparing, setPreparing] = useState(false), [imageError, setImageError] = useState(false);
  const { error, run } = useSettingsAction(open);
  useAnchoredPopover(trigger, panel, { side: "above" });
  useEffect(() => () => { preparation.current++; }, []);
  const close = () => { preparation.current++; setPreparing(false); panel.current?.hidePopover(); };
  async function selectPicture(value: File) {
    const current = ++preparation.current;
    setPreparing(true); setImageError(false);
    try {
      const image = await prepareIdentityImage(value);
      if (preparation.current === current) setPicture(image);
    } catch { if (preparation.current === current) setImageError(true); }
    finally { if (preparation.current === current) setPreparing(false); }
  }
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
        if (opened) { setDraft(name); setPicture(avatar); setImageError(false); input.current?.focus({ preventScroll: true }); }
        else { preparation.current++; setPreparing(false); }
      }}>
      <h2>{t("channel.profileEditor.editProfile")}</h2>
      <form onSubmit={event => {
        event.preventDefault();
        if (!draft.trim() || locked) return;
        void run(() => onSave({ name: draft.trim(), avatar: picture }), close);
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <div className="c3-profile-picture"><PawnSvg color={color} avatar={picture ?? undefined} />
          <div><Btn icon="arrowUp" size="dense" quiet title={{ text: t("channel.profileEditor.choosePicture") }} cap={{ text: t("channel.profileEditor.choosePicture") }}
            busy={preparing} disabled={locked} onClick={() => file.current?.click()} />
            {picture && <Btn icon="x" size="dense" quiet title={{ text: t("channel.profileEditor.removePicture") }} disabled={locked} onClick={() => setPicture(null)} />}
          </div>
          <input ref={file} type="file" accept="image/*" hidden onChange={event => {
            const value = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (value) void selectPicture(value);
          }} />
        </div>
        <label htmlFor={`${id}-name`}>{t("channel.profileEditor.nickname")}</label>
        <span className="lr-input"><input ref={input} id={`${id}-name`} maxLength={MAX_USER_NAME_UNITS} autoComplete="nickname"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled || busy} /></span>
        {(imageError || message) && <p className="c3-settings-error" role="alert">{imageError ? t("channel.profileEditor.imageOpenFailed") : message}</p>}
        <div className="c3-profile-actions">
          <Btn icon="x" size="dense" quiet title="common.cancel" cap="common.cancel" onClick={close} />
          <Btn icon="check" type="submit" size="dense" tone="primary" title={{ text: t("channel.profileEditor.saveProfile") }}
            cap={{ text: t("channel.profileEditor.saveProfile") }} busy={busy} disabled={locked || !draft.trim()} />
        </div>
      </form>
    </div>
  </>;
}
