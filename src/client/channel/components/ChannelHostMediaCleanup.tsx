import { useEffect, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import { useSettingsAction } from "../../ui/use-settings-action";
import type { ChannelController, HostMediaTarget } from "../types";
import { ChannelInlineConfirm } from "./ChannelInlineConfirm";
import { ChannelSettingsDialog, ChannelSettingsError } from "./ChannelSettingsDialog";
import "./channel-room-controls.css";

type CleanupResult = Awaited<ReturnType<ChannelController["clearHostMedia"]>>;

export function ChannelHostMediaCleanup({ channel, moreOpen, restoreFocus }: {
  channel: ChannelController;
  moreOpen: boolean;
  restoreFocus(): void;
}) {
  const { t } = useCopy();
  const { hostMediaTargets, connection, sessionId, appConnected, appPort } = channel;
  const [targets, setTargets] = useState<HostMediaTarget[]>([]);
  const [dialogTargets, setDialogTargets] = useState<HostMediaTarget[] | null>(null);
  const site = channel.state?.channel;
  const owner = !!channel.self && site?.ownerId === channel.self.id;
  const title = t("channel.hostMedia.title");
  const busy = [...channel.pending].some(key => key.startsWith("host-media:"));
  useEffect(() => {
    setTargets([]);
    if (!moreOpen) return;
    const lookup = new AbortController();
    void hostMediaTargets(lookup.signal).then(available => {
      if (!lookup.signal.aborted) setTargets(available);
    }).catch(() => {});
    return () => lookup.abort();
  }, [moreOpen, hostMediaTargets, connection, sessionId, site?.id, site?.hostingMode, owner, appConnected, appPort]);

  return <>
    {targets.length > 0 && <div className="lr-header-maintenance">
      <Btn icon="folder" size="compact" quiet title={{ text: title }} cap={{ text: t("channel.hostMedia.entry") }}
        onClick={() => setDialogTargets(targets)} />
    </div>}
    {dialogTargets && <ChannelSettingsDialog title={title} compact
      onClose={() => { setDialogTargets(null); restoreFocus(); }}>
      <div className="c3-settings-panels c3-host-media">
        <p>{t("channel.hostMedia.scope")}</p>
        <ul>
          {dialogTargets.map(target => <CleanupTarget key={target} target={target} channel={channel}
            disabled={busy || connection !== "connected" || target === "app" && !appConnected} />)}
        </ul>
      </div>
    </ChannelSettingsDialog>}
  </>;
}

function CleanupTarget({ channel, target, disabled }: {
  channel: ChannelController;
  target: HostMediaTarget;
  disabled: boolean;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const [result, setResult] = useState<CleanupResult | null>(null);
  const busy = channel.pending.has(`host-media:${target}`);
  const name = t(`channel.hostMedia.target.${target}`);
  // Cache (Browser) and compaction (Native) failures each count only rooms whose clear committed.
  const followUpFailures = result ? result.cacheFailures + result.compactionFailures : 0;
  const completedRooms = result ? result.clearedRooms - followUpFailures : 0;
  const retryRooms = result ? result.failedRooms + followUpFailures : 0;
  return <li>
    <strong>{name}</strong>
    <ChannelInlineConfirm label={t("channel.hostMedia.clear")}
      danger={false}
      accessibleLabel={t("channel.hostMedia.clearTarget", { target: name })}
      question={t("channel.hostMedia.confirm", { target: name })}
      busy={busy} disabled={disabled}
      onConfirm={() => {
        setResult(null);
        void run(() => channel.clearHostMedia(target), setResult);
      }} />
    <div className="c3-host-media-result" role="status">
      {busy && <p>{t("channel.hostMedia.clearing")}</p>}
      {result && <>
        <p data-result={completedRooms > 0 ? "cleared" : undefined}>
          {t("channel.hostMedia.result", { count: String(completedRooms) })}
        </p>
        {retryRooms > 0 && <p data-result="failed">
          {t("channel.hostMedia.retry", { count: String(retryRooms) })}
        </p>}
      </>}
    </div>
    <ChannelSettingsError error={error} />
  </li>;
}
