import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { BrandLoader } from "../../components/living/BrandMark";
import type { ChannelController } from "../types";
import type { ChannelErrorPresentation } from "../error-presentation";
import { ChannelAction } from "./ChannelAction";
import "./channel-room-controls.css";

/** Site connection precedes Welcome; room access stays with the room entry. */
export function ChannelSiteEntry({ channel, failure }: {
  channel: Pick<ChannelController, "connection" | "error" | "reconnect" | "joinAsNewIdentity">;
  failure: ChannelErrorPresentation;
}) {
  const { t } = useCopy();
  const connecting = channel.connection === "connecting" || channel.connection === "reconnecting";
  const identityRejected = channel.error === "invalid_credential";
  const showConnectionHelp = !connecting && failure.connectionHelp;
  const helpLabel = t("channel.siteEntry.connectionHelp");
  const title = connecting ? t("channel.siteEntry.connecting") : t("channel.siteEntry.connectionFailed");
  return <main className="c3-locked-room c3-site-entry" aria-labelledby="c3-site-entry-title">
    {connecting ? <BrandLoader /> : <Glyph name="signal" size={46} />}
    <h1 id="c3-site-entry-title">{title}</h1>
    <p className="c3-site-entry-address">{location.host}</p>
    {connecting ? <span role="status" className="visually-hidden">{title}</span>
        : <>{failure.message && <p role="alert">{failure.message}</p>}
          <ChannelAction icon="refresh" label={identityRejected ? t("channel.siteEntry.retrySavedIdentity") : t("channel.siteEntry.reconnect")} onClick={channel.reconnect} />
          {identityRejected && <>
            <ChannelAction icon="plus" label={t("channel.siteEntry.joinWithANewIdentity")} onClick={channel.joinAsNewIdentity} />
            <p>{t("channel.siteEntry.newIdentityNote")}</p>
          </>}
        </>}
    {showConnectionHelp && <details className="c3-connection-help">
      <summary className="lr-btn is-compact is-quiet"><Glyph name="book" size={18} />{helpLabel}</summary>
      <p>{t("channel.siteEntry.connectionAdvice")}</p>
    </details>}
  </main>;
}
