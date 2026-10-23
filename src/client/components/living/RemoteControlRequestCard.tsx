import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, NameTag } from "./primitives";
import type { RemoteControlRequest } from "../../native/wire";

// One participant requests remote control. The caller owns authorization.
export function RemoteControlRequestCard({ name, peerId, state,
  failed, decisionDisabled, stopDisabled, onAllow, onDecline, onStop }: {
  name: string; peerId: string;
  state: RemoteControlRequest["state"];
  failed?: boolean; decisionDisabled?: boolean; stopDisabled?: boolean;
  onAllow: () => void; onDecline: () => void; onStop: () => void;
}) {
  const { t, vis } = useCopy();
  const pending = state === "pending";
  return <div className={`lr-remote-request${pending ? " is-pending" : ""}`} role="group" aria-label={name}>
    <NameTag name={name} identity={peerId} />
    {!pending && <div className="lr-remote-request-stop">
      <Btn icon="x" title="remote.stop" size="dense" hint="hint-remote-stop" disabled={stopDisabled} onClick={onStop} />
    </div>}
    <div className="lr-remote-request-info">
      <p className="lr-remote-request-details">
        <Glyph name={pending ? "clock" : state === "suspended" ? "pause" : "mouse"} size={14} />
        <span className={vis ? "visually-hidden" : undefined}>{t(pending ? "remote.waiting" : state === "suspended" ? "remote.hostFocus" : "remote.controlling")}</span>
      </p>
      {failed && <p role="alert"><Glyph name="alert" size={14} />
        <span className={vis ? "visually-hidden" : undefined}>{t("remote.decisionFailed")}</span></p>}
    </div>
    {pending && <div className="lr-remote-request-actions">
      <Btn icon="x" title="remote.decline" cap="remote.decline" hint="hint-remote-stop" disabled={stopDisabled} onClick={onDecline} />
      <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" hint="hint-remote-control"
        disabled={decisionDisabled} onClick={onAllow} />
    </div>}
  </div>;
}
