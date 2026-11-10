import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { PawnSvg } from "../../components/living/Pawn";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { prepareIdentityImage } from "../identity-image";
import { channelErrorPresentation } from "../error-presentation";
import { useSettingsAction } from "./ChannelSettingsDialog";
import "./channel-profile-editor.css";

export function ChannelProfileEditor({ name, avatar, color, disabled, busy, onSave }: {
  name: string; avatar: string | null; color: string; disabled: boolean; busy: boolean;
  onSave(profile: { name: string; avatar: string | null }): Promise<void>;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
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
  const { message } = channelErrorPresentation(error, (cn, en) => zh ? cn : en);
  return <>
    <span ref={trigger} className="c3-profile-editor"><Btn icon="pencil" title={{ text: zh ? "修改个人资料" : "Edit profile" }}
      hint="hint-rename" size="dense" quiet disabled={disabled} popoverTarget={id} controls={id} expanded={open} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={zh ? "修改个人资料" : "Edit profile"}
      className="lr-anchored-card c3-name-popover" onToggle={event => {
        if (event.target !== event.currentTarget) return;
        const opened = event.newState === "open";
        setOpen(opened);
        if (opened) { setDraft(name); setPicture(avatar); setImageError(false); input.current?.focus({ preventScroll: true }); }
        else { preparation.current++; setPreparing(false); }
      }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!draft.trim() || locked) return;
        void run(() => onSave({ name: draft.trim(), avatar: picture }), close);
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <div className="c3-profile-picture"><PawnSvg color={color} avatar={picture ?? undefined} />
          <div><Btn icon="arrowUp" size="dense" quiet title={{ text: zh ? "选择头像" : "Choose picture" }} cap={{ text: zh ? "选择头像" : "Choose picture" }}
            busy={preparing} disabled={locked} onClick={() => file.current?.click()} />
            {picture && <Btn icon="x" size="dense" quiet title={{ text: zh ? "移除头像" : "Remove picture" }} disabled={locked} onClick={() => setPicture(null)} />}
          </div>
          <input ref={file} type="file" accept="image/*" hidden onChange={event => {
            const value = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (value) void selectPicture(value);
          }} />
        </div>
        <label htmlFor={`${id}-name`}>{zh ? "昵称" : "Nickname"}</label>
        <div className="c3-name-entry"><span className="lr-input"><input ref={input} id={`${id}-name`} maxLength={40} autoComplete="nickname"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled || busy} /></span>
          <Btn icon="check" type="submit" size="dense" tone="primary" title={{ text: zh ? "保存资料" : "Save profile" }} busy={busy} disabled={locked || !draft.trim()} />
          <Btn icon="x" size="dense" quiet title="common.cancel" onClick={close} />
        </div>
        {(imageError || message) && <p className="c3-settings-error" role="alert">{imageError ? (zh ? "这张图片无法打开，请换一张。" : "Couldn't open this image. Try another.") : message}</p>}
      </form>
    </div>
  </>;
}
