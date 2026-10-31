import { useEffect, useRef, useState } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { ChannelAction } from "../components/ChannelMedia";
import { ChannelIconChoices } from "../components/ChannelIdentity";
import type { DesignCopy } from "./fixtures";
import "./design-identity.css";

export type DesignIdentity = { icon: GlyphName; image?: File };

export function DesignIdentityMark({ value, size = 32 }: { value: DesignIdentity; size?: number }) {
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (!value.image) { setPreview(undefined); return; }
    const url = URL.createObjectURL(value.image);
    setPreview({ file: value.image, url });
    return () => URL.revokeObjectURL(url);
  }, [value.image]);
  return <span className="cd-identity-mark" style={{ width: size, height: size }} aria-hidden="true">
    {preview && preview.file === value.image ? <img src={preview.url} alt="" /> : <Glyph name={value.icon} size={size} />}
  </span>;
}

export function DesignIdentityPicker({ copy, value, onChange, busy, onBusyChange }: {
  copy: DesignCopy; value: DesignIdentity; onChange(value: DesignIdentity): void;
  busy: boolean; onBusyChange(busy: boolean): void;
}) {
  const chooser = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  async function chooseImage(file: File) {
    const current = ++request.current;
    setFailed(false);
    onBusyChange(true);
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (request.current === current) onChange({ icon: value.icon, image: file });
    } catch {
      if (request.current === current) setFailed(true);
    } finally {
      URL.revokeObjectURL(url);
      if (request.current === current) onBusyChange(false);
    }
  }
  return <fieldset className="cd-identity-picker">
    <legend>{copy("图标或图片", "Icon or image")}</legend>
    <ChannelIconChoices value={value.image ? "" : value.icon} onChange={icon => {
      request.current++; setFailed(false); onBusyChange(false); onChange({ icon });
    }} />
    <div className="cd-identity-upload">
      {value.image && <DesignIdentityMark value={value} size={36} />}
      <ChannelAction icon="arrowUp" quiet busy={busy}
        label={busy ? copy("正在打开图片…", "Opening image…") : copy(value.image ? "更换图片" : "选择图片", value.image ? "Change image" : "Choose image")}
        onClick={() => chooser.current?.click()} />
      <input ref={chooser} hidden type="file" accept="image/*" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void chooseImage(file);
      }} />
      {value.image && <ChannelAction icon="x" quiet label={copy("移除", "Remove")} onClick={() => {
        request.current++; setFailed(false); onBusyChange(false); onChange({ icon: value.icon });
      }} />}
    </div>
    {failed && <p className="cd-identity-error" role="alert">{copy("这张图片无法打开，请换一张。", "Couldn't open this image. Try another.")}</p>}
  </fieldset>;
}
