import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useCopy } from "../../ui/copy";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { ChannelAction } from "./ChannelAction";
import { Btn } from "../../components/living/primitives";
import { downloadBlob } from "../../lib/download";
import "./channel-invite-qr-code.css";

class InvitationCode extends Component<{ value: string; label: string; failure: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">{this.props.failure}</p>
      : <><QRCodeSVG data-invitation-code value={this.props.value} size={256} level="M" marginSize={4} title={this.props.label} />{this.props.children}</>;
  }
}

/** Each invitation owner supplies its exact URL, including the complete fragment. */
export function ChannelInviteQrCode({ url, disabled = false, label }: {
  url: string | null | undefined; disabled?: boolean; label: string;
}) {
  const { vis, lang } = useCopy(), zh = lang === "zh";
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  useAnchoredPopover(anchor, panel);
  useEffect(() => { setSaveFailed(false); if (!url) panel.current?.hidePopover(); }, [url]);
  const save = async () => {
    const svg = panel.current?.querySelector("svg[data-invitation-code]");
    if (!(svg instanceof SVGSVGElement)) return;
    setSaving(true); setSaveFailed(false);
    const imageSvg = svg.cloneNode(true) as SVGSVGElement;
    const edge = svg.viewBox.baseVal.width * 8;
    imageSvg.setAttribute("width", String(edge)); imageSvg.setAttribute("height", String(edge));
    const imageURL = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(imageSvg)], { type: "image/svg+xml" }));
    try {
      const image = new Image(); image.src = imageURL;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = edge;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("image_unavailable");
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("image_unavailable")), "image/png"));
      if (panel.current?.querySelector("svg[data-invitation-code]") === svg) downloadBlob(png, "piik-invitation.png");
    } catch {
      if (panel.current?.querySelector("svg[data-invitation-code]") === svg) setSaveFailed(true);
    } finally { URL.revokeObjectURL(imageURL); setSaving(false); }
  };
  return <>
    <span ref={anchor}><Btn icon="qr" title={{ text: label }} hint="hint-copy-invite" size="compact"
      disabled={!url || disabled} expanded={open} controls={id} popoverTarget={id} /></span>
    {createPortal(<div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      className="lr-anchored-card c3-invite-qr" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <header><strong id={`${id}-title`} className={vis ? "visually-hidden" : undefined}>{label}</strong>
        <ChannelAction icon="x" iconOnly quiet label={zh ? "关闭" : "Close"} onClick={() => panel.current?.hidePopover()} /></header>
      {open && url && <>
        <InvitationCode key={url} value={url} label={label} failure={zh ? "无法生成二维码，请复制邀请链接。" : "Could not create a QR code. Copy the invitation link instead."}>
          <footer><ChannelAction icon="save" label={zh ? "保存图片" : "Save image"} busy={saving} onClick={() => { void save(); }} /></footer>
        </InvitationCode>
        {saveFailed && <p role="alert">{zh ? "图片未能保存，请重试。" : "Could not save the image. Please try again."}</p>}
      </>}
    </div>, document.body)}
  </>;
}
