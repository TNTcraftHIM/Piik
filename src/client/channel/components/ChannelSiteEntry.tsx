import { useEffect, useRef, useState } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { BrandLoader } from "../../components/living/BrandMark";
import type { ChannelController } from "../types";
import type { ChannelErrorPresentation } from "../../components/error-presentation";
import { diagnosisGuide } from "../../ui/diagnosis";
import { currentSiteResponds } from "../site-health";
import { ChannelAction } from "./ChannelAction";
import "./channel-room-controls.css";

function SiteConnectionHelp({ checkSite }: { checkSite: boolean }) {
  const { lang, t } = useCopy();
  const [responded, setResponded] = useState<boolean | null>(null);
  const check = useRef<AbortController | null>(null);
  useEffect(() => () => check.current?.abort(), []);
  return <details className="c3-connection-help" onToggle={event => {
    check.current?.abort();
    setResponded(null);
    if (!checkSite || !event.currentTarget.open) return;
    const request = check.current = new AbortController();
    void currentSiteResponds(request.signal).then(result => {
      if (!request.signal.aborted) setResponded(result);
    });
  }}>
    <summary className="lr-btn is-compact is-quiet"><Glyph name="book" size={18} />{t("channel.siteEntry.connectionHelp")}</summary>
    {checkSite ? <p role="status">{t(responded === null ? "channel.siteEntry.checkingSite" :
      responded ? "channel.siteEntry.siteResponded" : "channel.siteEntry.siteUnconfirmed")}</p>
      : <p>{t("channel.siteEntry.connectionAdvice")}</p>}
    <a href={diagnosisGuide("site", lang).fallback} target="_blank" rel="noopener noreferrer">{t("diagnosis.guide")}</a>
  </details>;
}

/** Site connection precedes Welcome; room access stays with the room entry. */
export function ChannelSiteEntry({ channel, failure }: {
  channel: Pick<ChannelController, "connection" | "error" | "reconnect" | "joinAsNewIdentity">;
  failure: ChannelErrorPresentation;
}) {
  const { t } = useCopy();
  const connecting = channel.connection === "connecting" || channel.connection === "reconnecting";
  // A first join retries before it has a session ID, returning briefly to "connecting".
  const [retried, setRetried] = useState(false);
  if (!retried && channel.connection === "reconnecting") setRetried(true);
  const identityRejected = channel.error === "invalid_credential";
  const unknownFailure = !channel.error || channel.error === "disconnected" || channel.error === "session_expired";
  const checkSite = unknownFailure && (retried || channel.connection === "closed");
  const showConnectionHelp = checkSite || (!connecting && failure.connectionHelp);
  const showFailure = !connecting || channel.error === "session_expired";
  const title = connecting ? t("channel.siteEntry.connecting") : t("channel.siteEntry.connectionFailed");
  return <main className="c3-locked-room c3-site-entry" aria-labelledby="c3-site-entry-title">
    {connecting ? <BrandLoader /> : <Glyph name="signal" size={46} />}
    <h1 id="c3-site-entry-title">{title}</h1>
    <p className="c3-site-entry-address">{location.host}</p>
    {showFailure && failure.message && <p role="alert">{failure.message}</p>}
    {connecting ? <span role="status" className="visually-hidden">{title}</span>
        : <>
          <ChannelAction icon="refresh" label={identityRejected ? t("channel.siteEntry.retrySavedIdentity") : t("channel.siteEntry.reconnect")} onClick={channel.reconnect} />
          {identityRejected && <>
            <ChannelAction icon="plus" label={t("channel.siteEntry.joinWithANewIdentity")} onClick={channel.joinAsNewIdentity} />
            <p>{t("channel.siteEntry.newIdentityNote")}</p>
          </>}
        </>}
    {showConnectionHelp && <SiteConnectionHelp key={`${location.origin}:${checkSite}`} checkSite={checkSite} />}
  </main>;
}
