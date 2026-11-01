import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction, ChannelVideo, type SourceAudioControl } from "./ChannelMedia";
import type { ChannelScreenInput, ScreenPresentation } from "../types";
import "./channel-stage.css";
import type { InputTransport } from "../../remote-control/input-route";
import type { RemoteControlMode } from "../../remote-control/protocol";
import type { ChannelRemoteControlState, ChannelStopShortcut } from "../app-link";
import { HostRemoteControl } from "../../components/living/HostRemoteControl";
import { useCallback } from "react";

export interface ChannelStageSource {
  id: string;
  userId: string;
  name: string;
  roomName: string;
  /** This page controls the share; its actual endpoint can be the App. */
  owned: boolean;
  subscribed: boolean;
  paused: boolean;
  stream?: MediaStream;
  sourceAudio?: SourceAudioControl;
  inputs?: readonly ChannelScreenInput[];
  input?: InputTransport;
  remoteControl?: Omit<ChannelRemoteControlState, "requests"> & { requests: (ChannelRemoteControlState["requests"][number] & { name: string })[] };
  pending?: boolean;
  pausePending?: boolean;
  available?: boolean;
}

export interface ChannelStageProps {
  sources: ChannelStageSource[];
  focusedId: string | null;
  canSubscribe: boolean;
  onFocus: (id: string | null) => void;
  onWatch: (id: string) => void;
  onUnwatch: (id: string) => void;
  onPause: (id: string, paused: boolean) => void;
  onStop: (id: string) => void;
  onPresentation?: (flowId: string, stream: MediaStream, state: ScreenPresentation) => void;
  onInputPolicy: (publicationId: string, mode: RemoteControlMode, password?: string) => Promise<void>;
  onInputDecide: (publicationId: string, requestId: string, allow: boolean) => Promise<void>;
  onInputSimultaneous: (publicationId: string, enabled: boolean) => Promise<void>;
  onInputShortcut: (publicationId: string, key?: number) => Promise<ChannelStopShortcut>;
}

function SourceControl({ source, onInputPolicy, onInputDecide, onInputSimultaneous, onInputShortcut }: {
  source: ChannelStageSource & { remoteControl: NonNullable<ChannelStageSource["remoteControl"]> };
} & Pick<ChannelStageProps, "onInputPolicy" | "onInputDecide" | "onInputSimultaneous" | "onInputShortcut">) {
  const shortcut = useCallback((key?: number) => onInputShortcut(source.id, key), [onInputShortcut, source.id]);
  return <HostRemoteControl {...source.remoteControl} iconOnly size="compact"
    onPolicy={(mode, password) => onInputPolicy(source.id, mode, password)}
    onDecide={(id, allow) => onInputDecide(source.id, id, allow)}
    onShortcut={source.remoteControl.canSetStopShortcut ? shortcut : undefined}
    onSimultaneous={enabled => onInputSimultaneous(source.id, enabled)} />;
}

/** Subscription belongs to the caller. Focus only changes the layout of existing players. */
export function ChannelStage({ sources, focusedId, canSubscribe, onFocus, onWatch, onUnwatch, onPause, onStop, onPresentation,
  onInputPolicy, onInputDecide, onInputSimultaneous, onInputShortcut }: ChannelStageProps) {
  const { lang, vis, t } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const active = sources.filter(source => source.owned || source.subscribed);
  const available = sources.filter(source => !source.owned && !source.subscribed);
  const focused = active.find(source => source.id === focusedId);
  if (!sources.length) return null;

  return <section className="c3-monitor" aria-label={copy("共享画面", "Shared screens")}>
    {available.length > 0 && <section className="c3-monitor-directory" aria-label={copy("可观看的画面", "Available screens")}>
      <div className="c3-monitor-directory-heading"><Glyph name="tv" size={17} />
        <span>{copy("正在分享", "Available to watch")}</span><small>{available.length}</small>
      </div>
      <div className="c3-monitor-offers">
        {available.map(source => <div key={source.id} className="c3-monitor-offer" data-source-id={source.id}
          role="group" aria-label={source.name}>
          <PawnSvg color={participantColor(source.userId)} identity={source.userId} />
          <div><strong>{source.name}</strong><small>{source.paused ? `${t("host.paused")} / ` : ""}{source.roomName}</small></div>
          <ChannelAction icon="eye" label={copy("观看", "Watch")}
            iconOnly={vis} disabled={!canSubscribe || source.available === false} busy={source.pending}
            onClick={() => onWatch(source.id)} />
        </div>)}
      </div>
    </section>}
    {active.length > 0 && <>
      <header className="c3-monitor-heading">
        <div><Glyph name="tv" size={18} /><span>{copy("画面", "Screens")}</span><small>{active.length}</small></div>
        {active.length > 1 && <div className="c3-monitor-layout" role="group" aria-label={copy("画面布局", "Screen layout")}>
          <ChannelAction icon="frames" label={copy("平铺画面", "Grid view")} quiet pressed={!focused}
            onClick={() => onFocus(null)} />
          {focused && <span className="c3-monitor-focus-name"><Glyph name="eye" size={15} />{focused.name}</span>}
        </div>}
      </header>
      <div className={`c3-monitor-grid${focused ? " is-focused" : ""}`}>
        {active.map(source => {
          const isFocused = source.id === focused?.id;
          const focusable = active.length > 1 && !isFocused;
          return <article key={source.id} className={`c3-monitor-tile${isFocused ? " is-focused" : ""}`}
            data-publication-id={source.id} data-focusable={focusable || undefined}
            aria-label={`${source.name} — ${source.roomName}`}
            onClick={event => {
              if (!focusable || (event.target instanceof Element && event.target.closest("button, input, select, a"))) return;
              onFocus(source.id);
            }}>
            {source.stream ? <ChannelVideo stream={source.stream} local={source.owned} inputs={source.inputs} onPresentation={onPresentation} input={source.input}
              sourceAudio={source.sourceAudio}
              label={`${source.name} — ${source.roomName}`} />
              : <div className="c3-monitor-wait" role="status">
                <Glyph name={source.paused ? "pause" : "loader"} size={24} className={source.paused ? undefined : "lr-spin"} />
                <span>{source.paused ? t("host.pauseNotice") : copy("正在连接画面", "Connecting picture")}</span></div>}
            <footer>
              <PawnSvg color={participantColor(source.userId)} identity={source.userId} />
              <div className="c3-monitor-source"><strong>{source.name}</strong>
                <small>{source.paused ? `${t("host.paused")} / ` : source.owned ? `${copy("本机预览", "Local preview")} / ` : ""}{source.roomName}</small>
              </div>
              <div className="c3-monitor-tile-actions">
                {source.owned && source.remoteControl && <SourceControl source={{ ...source, remoteControl: source.remoteControl }}
                  onInputPolicy={onInputPolicy} onInputDecide={onInputDecide} onInputSimultaneous={onInputSimultaneous} onInputShortcut={onInputShortcut} />}
                {active.length > 1 && <ChannelAction icon={isFocused ? "contract" : "expand"} quiet iconOnly
                  label={isFocused ? copy("返回平铺", "Return to grid") : copy(`聚焦 ${source.name}`, `Focus ${source.name}`)}
                  pressed={isFocused} onClick={() => onFocus(isFocused ? null : source.id)} />}
                {source.owned && <ChannelAction icon={source.paused ? "play" : "pause"} quiet iconOnly
                  label={t(source.paused ? "host.resume" : "host.pause")} pressed={source.paused}
                  hint={source.paused ? "hint-resume" : "hint-pause"} busy={source.pausePending}
                  onClick={() => onPause(source.id, !source.paused)} />}
                <ChannelAction icon={source.owned ? "stop" : "x"} danger={source.owned} quiet={!source.owned} iconOnly
                  label={source.owned ? copy(`停止分享 ${source.name}`, `Stop sharing ${source.name}`)
                    : copy(`停止观看 ${source.name}`, `Stop watching ${source.name}`)}
                  hint={source.owned ? "hint-share-stop" : "hint-close"} busy={source.pending}
                  onClick={() => source.owned ? onStop(source.id) : onUnwatch(source.id)} />
              </div>
            </footer>
          </article>;
        })}
      </div>
    </>}
  </section>;
}
