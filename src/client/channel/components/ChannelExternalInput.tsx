import { useId } from "react";
import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import type { NativeExternalInput } from "../app-link";
import { channelErrorPresentation } from "../error-presentation";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import "./channel-share-control.css";

function ConnectionField({ label, value }: { label: string; value: string }) {
  const id = useId(), { lang } = useCopy(), copy = useClipboardResult(value);
  const zh = lang === "zh";
  return <div className="c3-external-input-field">
    <label htmlFor={id}>{label}</label>
    <div><input id={id} className="c3-input" readOnly value={value} onFocus={event => event.currentTarget.select()} />
      <ChannelAction icon={copy.status === "copied" ? "check" : "copy"} quiet
        label={copy.status === "copied" ? (zh ? "已复制" : "Copied") : `${zh ? "复制" : "Copy"} ${label}`} onClick={copy.copy} /></div>
    {copy.status === "failed" && <p role="status">{zh ? "请选中内容后手动复制。" : "Select the value and copy it manually."}</p>}
  </div>;
}

export function ChannelExternalInput({ input, busy, onStop, onClose }: {
  input: NativeExternalInput; busy: boolean; onStop(): void; onClose(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const state = input.state === "live" ? (zh ? "正在分享 OBS 画面" : "Sharing OBS output")
    : input.state === "prepared" ? (zh ? "正在连接画面…" : "Connecting the picture…")
      : (zh ? "等待 OBS 开始推流" : "Waiting for OBS to start");
  const { message } = channelErrorPresentation(input.error ?? null, (cn, en) => zh ? cn : en);
  return <ChannelSettingsDialog title="OBS / WHIP" compact onClose={onClose}>
    <div className="c3-settings-panels c3-external-input">
      <p role="status">{state}</p>
      <p>{zh ? "在本机 OBS 中选择 WHIP 推流，使用 H.264 画面和 Opus 声音，填写以下两项。" : "Choose WHIP in this computer's OBS, use H.264 video and Opus audio, and enter these two values."}</p>
      <ConnectionField label="Server" value={input.endpoint} />
      <ConnectionField label="Bearer Token" value={input.token} />
      <p>{zh ? "画质和声音在 OBS 中设置。停止推流会结束当前画面，重新开播后观众需再次观看；此连接仍可继续使用。关闭分享页或下方停止会结束本次连接。"
        : "Configure picture and sound in OBS. Stopping the stream ends the picture; viewers watch again when you restart. This connection stays available until you close the sharing page or stop below."}</p>
      {message && <p className="c3-settings-error" role="alert">{message}</p>}
      <ChannelAction icon="stop" danger label={zh ? "停止 OBS 分享" : "Stop OBS sharing"} busy={busy} onClick={onStop} />
    </div>
  </ChannelSettingsDialog>;
}
