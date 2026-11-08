import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelVideo, type SourceAudioControl } from "./ChannelMedia";
import { ChannelAction } from "./ChannelAction";
import type { ChannelScreenInput, ScreenPresentation } from "../types";
import "./channel-stage.css";
import type { InputTransport } from "../../remote-control/input-route";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import type { RemoteControlMode } from "../../remote-control/protocol";
import type { ChannelRemoteControlState, ChannelStopShortcut } from "../app-link";
import { HostRemoteControl } from "../../components/living/HostRemoteControl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { stageColumns } from "../stage-layout";
import { useTheaterMode } from "../../components/living/use-theater-mode";
import { VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { Cap } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";

export interface ChannelStageSource {
  id: string;
  userId: string;
  name: string;
  roomName: string;
  /** This page controls the share; its actual endpoint can be the App. */
  owned: boolean;
  subscribed: boolean;
  paused: boolean;
  deliveryFailed?: boolean;
  stream?: MediaStream;
  sourceAudio?: SourceAudioControl;
  shareControls?: ReactNode;
  interaction?: RoomInteractionSession | null;
  sourceMicrophone?: { enabled: boolean; busy?: boolean; disabled?: boolean; canDisable?: boolean; onEnabled: (enabled: boolean) => void };
  inputs?: readonly ChannelScreenInput[];
  input?: InputTransport;
  remoteControl?: Omit<ChannelRemoteControlState, "requests"> & { requests: (ChannelRemoteControlState["requests"][number] & { name: string })[] };
  pending?: boolean;
  pausePending?: boolean;
  pauseAvailable?: boolean;
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
  const layoutSources = JSON.stringify([active.map(source => source.id), available.map(source => source.id)]);
  const [theater, setTheater] = useTheaterMode();
  const stage = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<number>();
  useLayoutEffect(() => {
    const parent = stage.current, tiles = grid.current;
    if (!parent || !tiles || focused || theater || active.length < 2) { setColumns(undefined); return; }
    const measure = () => {
      const style = getComputedStyle(parent), children = [...parent.children] as HTMLElement[];
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(style.rowGap) || 0;
      const height = parent.clientHeight - padding - children.filter(child => child !== tiles).reduce((sum, child) => sum + child.offsetHeight, 0)
        - gap * (children.length - 1);
      const footer = Math.max(...[...tiles.querySelectorAll("article > footer")].map(node => node.getBoundingClientRect().height)) + 2;
      const layout = getComputedStyle(tiles);
      const ratios = [...tiles.children].map(tile => {
        const video = tile.querySelector<HTMLVideoElement>('video[data-selected="true"]');
        return video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      });
      setColumns(stageColumns(tiles.clientWidth, height, ratios, parseFloat(layout.columnGap) || 0, footer,
        parseFloat(layout.getPropertyValue("--stage-tile-min"))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    for (const child of parent.children) if (child !== tiles) observer.observe(child);
    for (const footer of tiles.querySelectorAll("article > footer")) observer.observe(footer);
    tiles.addEventListener("loadedmetadata", measure, true);
    tiles.addEventListener("resize", measure, true);
    measure();
    return () => {
      observer.disconnect();
      tiles.removeEventListener("loadedmetadata", measure, true);
      tiles.removeEventListener("resize", measure, true);
    };
  }, [layoutSources, focused?.id, theater, lang]);
  useEffect(() => { if (!focused?.stream) setTheater(false); }, [focused?.id, focused?.stream, setTheater]);
  if (!sources.length) return null;

  return <section ref={stage} className={`c3-monitor${theater && focused ? " is-theater" : ""}`} aria-label={copy("共享画面", "Shared screens")}>

    {active.length > 0 && <>
      <header className="c3-monitor-heading">
        <div><Glyph name="tv" size={18} /><Cap k={{ text: copy("画面", "Screens") }} /><small>{active.length}</small></div>
        {active.length > 1 && <div className="c3-monitor-layout" role="group" aria-label={copy("画面布局", "Screen layout")}>
          <ChannelAction icon="frames" label={copy("平铺画面", "Grid view")} quiet pressed={!focused}
            hint="hint-screen-grid" onClick={() => onFocus(null)} />
          {focused && <span className="c3-monitor-focus-name"><Glyph name="eye" size={15} />{focused.name}</span>}
          {theater && <label className="c3-theater-source"><Cap k={{ text: copy("切换画面", "Switch screen") }} />
            <select className="lr-select" aria-label={copy("切换画面", "Switch screen")} value={focused?.id ?? ""} onChange={event => onFocus(event.target.value)}>
              {active.map(source => <option key={source.id} value={source.id}>{source.name} — {source.roomName}</option>)}
            </select></label>}
        </div>}
      </header>
      <div ref={grid} className={`c3-monitor-grid${focused ? " is-focused" : ""}`}
        style={columns && !focused && !theater ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {active.map(source => {
          const isFocused = source.id === focused?.id;
          const focusable = active.length > 1 && !isFocused;
          const microphone = source.sourceMicrophone;
          const sourceStatus = source.paused ? t("host.paused") : source.owned ? copy("本机预览", "Local preview") : "";
          const sourceDetail = (!vis && sourceStatus ? `${sourceStatus} / ` : "") + source.roomName;
          return <article key={source.id} className={`c3-monitor-tile${isFocused ? " is-focused" : ""}`}
            data-publication-id={source.id} data-focusable={focusable || undefined}
            aria-label={`${source.name} — ${source.roomName}`}
            onClick={event => {
              if (!focusable || (event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) return;
              onFocus(source.id);
            }}>
            {source.stream ? <ChannelVideo stream={source.stream} local={source.owned} inputs={source.inputs} onPresentation={onPresentation} input={source.input}
              sourceAudio={source.sourceAudio} interaction={source.interaction}
              theaterMode={theater && isFocused} onToggleTheater={() => {
                onFocus(source.id); setTheater(!theater);
              }}
              label={`${source.name} — ${source.roomName}`} />
              : <div className="c3-monitor-wait" data-failed={!source.paused && source.deliveryFailed || undefined} role="status">
                <Glyph name={source.paused ? "pause" : source.deliveryFailed ? "x" : "loader"} size={24} className={source.paused || source.deliveryFailed ? undefined : "lr-spin"} />
                <span>{source.paused ? t("host.pauseNotice") : source.deliveryFailed
                  ? copy("画面传输失败，正在重试。", "Picture delivery failed. Retrying.")
                  : copy("正在连接画面", "Connecting picture")}</span></div>}
            <footer>
              <PawnSvg color={participantColor(source.userId)} identity={source.userId} />
              <div className="c3-monitor-source">
                <Tooltip overflow={{ text: source.name, selector: "strong" }}><strong>{source.name}</strong></Tooltip>
                <Tooltip overflow={{ text: sourceDetail, selector: "small" }}><small aria-label={sourceStatus ? `${sourceStatus} / ${source.roomName}` : undefined}>
                  {vis && sourceStatus && <Glyph name={source.paused ? "pause" : "tv"} size={10} />}{sourceDetail}
                </small></Tooltip>
              </div>
              <div className="c3-monitor-tile-actions">
                {source.owned && source.shareControls}
                {source.owned && source.remoteControl && <SourceControl source={{ ...source, remoteControl: source.remoteControl }}
                  onInputPolicy={onInputPolicy} onInputDecide={onInputDecide} onInputSimultaneous={onInputSimultaneous} onInputShortcut={onInputShortcut} />}
                {active.length > 1 && <ChannelAction icon={isFocused ? "contract" : "expand"} quiet iconOnly
                  label={isFocused ? copy("返回平铺", "Return to grid") : copy(`聚焦 ${source.name}`, `Focus ${source.name}`)}
                  hint={isFocused ? "hint-screen-grid" : "hint-screen-focus"}
                  pressed={isFocused} onClick={() => onFocus(isFocused ? null : source.id)} />}
                {source.owned && microphone && <VoiceMicrophoneButton active={microphone.enabled}
                  quiet busy={microphone.busy && !(microphone.enabled && microphone.canDisable)}
                  disabled={(microphone.disabled || microphone.busy) && !(microphone.enabled && microphone.canDisable)}
                  hint={microphone.enabled ? "hint-microphone-off" : "hint-microphone-on"}
                  onClick={() => microphone.onEnabled(!microphone.enabled)} />}
                {source.owned && <ChannelAction icon={source.paused ? "play" : "pause"} quiet iconOnly
                  label={t(source.paused ? "host.resume" : "host.pause") + (source.pauseAvailable === false
                    ? copy("（重新连接后可用）", " (available after reconnecting)") : "")} pressed={source.paused}
                  disabled={source.pauseAvailable === false}
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
    {available.length > 0 && <section className="c3-monitor-directory" aria-label={copy("可观看的画面", "Available screens")}>
      <div className="c3-monitor-directory-heading"><Glyph name="tv" size={17} />
        <Cap k={{ text: copy("正在分享", "Available to watch") }} /><small>{available.length}</small>
      </div>
      <div className="c3-monitor-offers">
        {available.map(source => <div key={source.id} className="c3-monitor-offer" data-source-id={source.id}
          role="group" aria-label={source.name}>
          <PawnSvg color={participantColor(source.userId)} identity={source.userId} />
          <div><strong>{source.name}</strong><small>{source.paused ? `${t("host.paused")} / ` : ""}{source.roomName}</small></div>
          <ChannelAction icon="eye" label={copy("观看", "Watch")}
            hint="hint-watch"
            iconOnly={vis} disabled={!canSubscribe || source.available === false} busy={source.pending}
            onClick={() => onWatch(source.id)} />
        </div>)}
      </div>
    </section>}
  </section>;
}
