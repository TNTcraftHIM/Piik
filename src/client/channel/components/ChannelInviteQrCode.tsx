import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useCopy } from "../../ui/copy";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { ChannelAction } from "./ChannelAction";
import { Btn } from "../../components/living/primitives";
import { downloadBlob } from "../../lib/download";
import { Glyph } from "../../ui/icons";
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
export function ChannelInviteQrCode({ url, disabled = false, label, presentation = "popover" }: {
  url: string | null | undefined; disabled?: boolean; label: string; presentation?: "popover" | "inline";
}) {
  const { t } = useCopy();
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  useAnchoredPopover(anchor, panel, { enabled: presentation === "popover" });
  useEffect(() => {
    setSaveFailed(false);
    if (!url || disabled) { if (panel.current?.matches(":popover-open")) panel.current.hidePopover(); setOpen(false); }
  }, [url, disabled]);
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
  const content = open && url && <>
    <InvitationCode key={url} value={url} label={label} failure={t("channel.inviteQrCode.generationFailed")}>
      <footer><ChannelAction icon="save" label={t("channel.inviteQrCode.saveImage")} busy={saving} onClick={() => { void save(); }} /></footer>
    </InvitationCode>
    {saveFailed && <p role="alert">{t("channel.inviteQrCode.saveFailed")}</p>}
  </>;
  if (presentation === "inline") return <details className="c3-invite-qr-details" open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={label} aria-disabled={!url || disabled || undefined}
      onClick={event => { if (!url || disabled) event.preventDefault(); }}><Glyph name="qr" size={18} /><span>{label}</span></summary>
    <div ref={panel} className="c3-invite-qr-content">{content}</div>
  </details>;
  return <>
    <span ref={anchor}><Btn icon="qr" title={{ text: label }} hint="hint-copy-invite" size="compact"
      disabled={!url || disabled} expanded={open} controls={id} popoverTarget={id} /></span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      className="lr-anchored-card c3-invite-qr" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <header><strong id={`${id}-title`}>{label}</strong>
        <ChannelAction icon="x" iconOnly quiet label={t("channel.inviteQrCode.close")} onClick={() => panel.current?.hidePopover()} /></header>
      {content}
    </div>
  </>;
}
