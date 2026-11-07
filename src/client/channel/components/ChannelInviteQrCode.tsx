import { Component, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useCopy } from "../../ui/copy";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { ChannelAction } from "./ChannelAction";
import { Btn } from "../../components/living/primitives";
import "./channel-invite-qr-code.css";

class InvitationCode extends Component<{ value: string; label: string; failure: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">{this.props.failure}</p>
      : <QRCodeSVG value={this.props.value} size={256} level="M" marginSize={4} title={this.props.label} />;
  }
}

/** The room owner supplies the exact invitation URL, including room and invite fragments. */
export function ChannelInviteQrCode({ url, disabled = false, label, closeLabel, hint, failure }: {
  url: string | null | undefined; disabled?: boolean; label: string; closeLabel: string; hint: string; failure: string;
}) {
  const { vis } = useCopy();
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(anchor, panel);
  useEffect(() => { if (!url) panel.current?.hidePopover(); }, [url]);
  return <>
    <span ref={anchor}><Btn icon="qr" title={{ text: label }} hint="hint-copy-invite" size="compact"
      disabled={!url || disabled} expanded={open} controls={id} popoverTarget={id} /></span>
    {createPortal(<div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      className="lr-anchored-card c3-invite-qr" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <header><strong id={`${id}-title`} className={vis ? "visually-hidden" : undefined}>{label}</strong>
        <ChannelAction icon="x" iconOnly quiet label={closeLabel} onClick={() => panel.current?.hidePopover()} /></header>
      {open && url && <>
        <InvitationCode key={url} value={url} label={label} failure={failure} />
        <p className={vis ? "visually-hidden" : undefined}>{hint}</p>
      </>}
    </div>, document.body)}
  </>;
}
