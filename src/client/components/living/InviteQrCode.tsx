import { Component, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";
import { useAnchoredPopover } from "./use-anchored-popover";
import "./invite-qr-code.css";

// Encoding failure belongs to this optional representation, never the Host page.
class InvitationCode extends Component<{ value: string; label: string; failure: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">{this.props.failure}</p>
      : <QRCodeSVG value={this.props.value} size={256} level="M" marginSize={4} title={this.props.label} />;
  }
}

/** The invitation owner supplies the exact displayed/copied URL, including its fragment. */
export function InviteQrCode({ url, disabled = false }: { url: string | null | undefined; disabled?: boolean }) {
  const { t, vis } = useCopy();
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(anchor, panel);
  useEffect(() => { if (!url || disabled) panel.current?.hidePopover(); }, [url, disabled]);
  return <>
    <span ref={anchor}>
      <Btn icon="qr" title="host.invite.qr" cap="host.invite.qrShort" hint="hint-invite-link"
        disabled={!url || disabled} expanded={open} controls={id} popoverTarget={id} />
    </span>
    {createPortal(<div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      className="lr-anchored-card lr-invite-qr" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <header><strong id={`${id}-title`} className={vis ? "visually-hidden" : undefined}>{t("host.invite.qr")}</strong>
        <button type="button" className="lr-btn is-dense is-quiet" aria-label={t("common.close")}
          onClick={() => panel.current?.hidePopover()}><Glyph name="x" size={16} /></button>
      </header>
      {open && url && <>
        <InvitationCode key={url} value={url} label={t("host.invite.qr")} failure={t("host.invite.qrFailed")} />
        <p className={vis ? "visually-hidden" : undefined}>{t("host.invite.qrHint")}</p>
      </>}
    </div>, document.body)}
  </>;
}
