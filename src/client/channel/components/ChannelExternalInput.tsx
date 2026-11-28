import { useId } from "react";
import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import type { NativeExternalInput } from "../app-link";
import { channelErrorPresentation } from "../../components/error-presentation";
import { ChannelDiagnosisHelp } from "../../components/ChannelDiagnosisHelp";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import "./channel-share-control.css";

function ConnectionField({ label, value }: { label: string; value: string }) {
  const id = useId(), { t } = useCopy(), copy = useClipboardResult(value);
  return <div className="c3-external-input-field">
    <label htmlFor={id}>{label}</label>
    <div><input id={id} className="c3-input" readOnly value={value} onFocus={event => event.currentTarget.select()} />
      <ChannelAction icon={copy.status === "copied" ? "check" : "copy"} quiet iconOnly textTooltip
        label={copy.status === "copied" ? t("screen.copied") : t("screen.copyField", { label })} onClick={copy.copy} /></div>
    {copy.status === "failed" && <p role="status">{t("screen.copyManually")}</p>}
  </div>;
}

export function ChannelExternalInput({ input, busy, onStop, onClose }: {
  input: NativeExternalInput; busy: boolean; onStop(): void; onClose(): void;
}) {
  const { t } = useCopy();
  const state = input.state === "live" ? t("screen.obsLive")
    : input.state === "prepared" ? t("screen.obsConnecting")
      : t("screen.obsWaitingToStart");
  const { message } = channelErrorPresentation(input.error ?? (input.state === "error" ? "external_input_failed" : null), t,
    "channel.error.externalInputFailed", input.unsupportedVideoFormat);
  return <ChannelSettingsDialog title="OBS / WHIP" compact onClose={onClose}>
    <div className="c3-settings-panels c3-external-input">
      {message ? <>
        <p className="c3-settings-error" role="alert">{message}</p>
        <ChannelDiagnosisHelp diagnosis={{ topic: "obs" }} />
      </> : <p role="status">{state}</p>}
      <p>{t("screen.obsInstructions")}</p>
      <ConnectionField label="Server" value={input.endpoint} />
      <ConnectionField label="Bearer Token" value={input.token} />
      <p>{t("screen.obsLifecycle")}</p>
      <ChannelAction icon="stop" danger label={t(input.state === "live" ? "screen.obsStop" : "screen.obsCancel")} busy={busy} onClick={onStop} />
    </div>
  </ChannelSettingsDialog>;
}
