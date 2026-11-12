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
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { stageColumns } from "../stage-layout";
import { useTheaterMode } from "../../components/living/use-theater-mode";
import { VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { Btn, Cap } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { ChannelUser } from "./ChannelUser";
import { screenTitle, type ScreenAudiencePerson } from "../presentation";
import type { MessageReactions } from "../protocol";
import { ChannelContentReactions } from "./ChannelContentReactions";
import { BrandLoader } from "../../components/living/BrandMark";

export interface ChannelStageSource {
  id: string;
  userId: string;
  name: string;
  source: { kind: "screen" | "camera"; name: string | null };
  title: string | null;
  onRoom?: () => void;
  avatar?: string;
  roomName: string;
  /** This page controls the share; its actual endpoint can be the App. */
  owned: boolean;
  /** This source runs on this machine; preview audio must not feed back. */
  localSource: boolean;
  subscribed: boolean;
  /** A different room is being browsed; the same player retains its watch. */
  hidden?: boolean;
  paused: boolean;
  audience: readonly ScreenAudiencePerson[];
  reactions?: MessageReactions;
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

export function SourceAudience({ people }: { people: readonly ScreenAudiencePerson[] }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above", align: "end", maxHeight: 360 });
  const count = people.filter(person => person.state === "active").length;
  return <span ref={trigger} className="c3-screen-audience">
    <Btn icon="eye" iconOverlay={<span aria-hidden="true">{count}</span>} quiet size="dense" expanded={open} controls={id} popoverTarget={id}
      title={{ text: zh ? `观看者：${count} 人正在观看` : `Viewers: ${count} watching` }} />
    <div id={id} ref={panel} popover="auto" role="dialog" aria-label={zh ? "此画面的观看者" : "Viewers of this screen"}
      className="lr-anchored-card c3-screen-audience-panel" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <h3>{zh ? "此画面的观看者" : "Viewers of this screen"}</h3>
      {people.length ? people.map(person => <ChannelUser key={person.userId} id={person.userId} name={person.name} avatar={person.avatar}
        self={false} owner={false} online activity={person.state === "active" ? (zh ? "正在观看" : "Watching")
          : person.state === "preparing" ? (zh ? "正在连接" : "Connecting") : (zh ? "传输失败，正在重试" : "Delivery failed. Retrying.")} />)
        : <p>{zh ? "还没有人观看此画面。" : "No one is watching this screen yet."}</p>}
    </div>
  </span>;
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
  return <HostRemoteControl {...source.remoteControl} iconOnly size="dense"
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
  const retained = sources.filter(source => source.owned || source.subscribed);
  const active = retained.filter(source => !source.hidden);
  const available = sources.filter(source => !source.hidden && !source.owned && !source.subscribed);
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
      const availableHeight = Math.min(parent.clientHeight, Math.max(160, window.innerHeight - parent.getBoundingClientRect().top));
      const height = availableHeight - padding - children.filter(child => child !== tiles).reduce((sum, child) => sum + child.offsetHeight, 0)
        - gap * (children.length - 1);
      const footer = Math.max(...[...tiles.querySelectorAll("article:not([hidden]) > footer")].map(node => node.getBoundingClientRect().height)) + 2;
      const layout = getComputedStyle(tiles);
      const ratios = [...tiles.children].filter(tile => !(tile as HTMLElement).hidden).map(tile => {
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
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      tiles.removeEventListener("loadedmetadata", measure, true);
      tiles.removeEventListener("resize", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [layoutSources, focused?.id, theater, lang]);
  useLayoutEffect(() => {
    for (const tile of grid.current?.querySelectorAll<HTMLElement>('article[hidden], article.is-thumbnail') ?? []) {
      for (const panel of tile.querySelectorAll<HTMLElement>('[popover]:popover-open')) panel.hidePopover();
    }
  }, [layoutSources, focused?.id]);
  useEffect(() => { if (!focused?.stream) setTheater(false); }, [focused?.id, focused?.stream, setTheater]);
  if (!sources.length) return null;

  return <section ref={stage} hidden={!active.length && !available.length} className={`c3-monitor${theater && focused ? " is-theater" : ""}`} aria-label={copy("共享画面", "Shared screens")}>

    {retained.length > 0 && <>
      <header className="c3-monitor-heading" hidden={!active.length}>
        <div><Glyph name="tv" size={18} /><Cap k={{ text: copy("画面", "Screens") }} /><small>{active.length}</small></div>
        {active.length > 1 && <div className="c3-monitor-layout">
          {focused && <label className="c3-theater-source">
            <select className="lr-select" aria-label={copy("切换画面", "Switch screen")} value={focused.id} onChange={event => onFocus(event.target.value)}>
              {active.map(source => <option key={source.id} value={source.id}>{screenTitle(source, lang)} / {source.name} / {source.roomName}</option>)}
            </select></label>}
          <div className="lr-toggle" role="group" aria-label={copy("画面布局", "Screen layout")}>
            <Tooltip kind="hint-screen-grid" text={vis ? undefined : copy("平铺画面", "Grid view")}>
              <button type="button" className={!focused ? "is-selected" : undefined} aria-pressed={!focused}
                aria-label={copy("平铺画面", "Grid view")} onClick={() => onFocus(null)}>
                <Glyph name="screenGrid" size={16} />{!vis && <span>{copy("网格", "Grid")}</span>}
              </button>
            </Tooltip>
            <Tooltip kind="hint-screen-focus" text={vis ? undefined : copy("聚焦画面", "Focus view")}>
              <button type="button" className={focused ? "is-selected" : undefined} aria-pressed={!!focused}
                aria-label={copy("聚焦画面", "Focus view")} onClick={() => onFocus(focused?.id ?? active[0].id)}>
                <Glyph name="screenFocus" size={16} />{!vis && <span>{copy("聚焦", "Focus")}</span>}
              </button>
            </Tooltip>
          </div>
        </div>}
      </header>
      <div ref={grid} hidden={!active.length} className={`c3-monitor-grid${focused ? " is-focused" : active.length > 1 ? " is-grid" : ""}`}
        style={{ "--stage-columns": columns ?? 1, "--stage-thumbnails": Math.max(1, active.length - 1) } as CSSProperties}>
        {retained.map(source => {
          const index = active.indexOf(source);
          const isFocused = source.id === focused?.id;
          const thumbnail = !source.hidden && !!focused && !isFocused;
          const focusable = active.length > 1 && !isFocused;
          const remainder = active.length % (columns ?? 1);
          const centeredStart = !source.hidden && !focused && remainder && index === active.length - remainder ? (columns ?? 1) - remainder + 1 : undefined;
          const microphone = source.sourceMicrophone;
          const sourceDetail = `${source.name} / ${source.roomName}${source.localSource ? ` / ${copy("本机预览", "Local preview")}` : ""}`;
          const title = screenTitle(source, lang);
          return <article key={source.id} hidden={source.hidden} inert={source.hidden} className={`c3-monitor-tile${isFocused ? " is-focused" : ""}${thumbnail ? " is-thumbnail" : ""}`}
            style={centeredStart ? { gridColumn: `${centeredStart} / span 2` } : undefined}
            data-publication-id={source.id} data-focusable={focusable || undefined}
            aria-label={`${title} / ${source.name} / ${source.roomName}`}
            onClick={event => {
              if (!focusable || (event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) return;
              onFocus(source.id);
            }}>
            {source.stream ? <ChannelVideo stream={source.stream} owned={source.owned} localSource={source.localSource}
              presentation={source.hidden ? "background" : thumbnail ? "thumbnail" : "full"} inputs={source.inputs} onPresentation={onPresentation} input={source.input}
              sourceAudio={source.sourceAudio} interaction={source.interaction}
              theaterMode={theater && isFocused} onToggleTheater={() => {
                onFocus(source.id); setTheater(!theater);
              }}
              label={`${title} / ${source.name} / ${source.roomName}`} />
              : <div className="c3-monitor-wait" data-failed={!source.paused && source.deliveryFailed || undefined} role="status">
                {source.paused || source.deliveryFailed ? <Glyph name={source.paused ? "pause" : "x"} size={24} /> : <BrandLoader />}
                <span>{source.paused ? t("host.pauseNotice") : source.deliveryFailed
                  ? copy("画面传输失败，正在重试。", "Picture delivery failed. Retrying.")
                  : copy("正在连接画面", "Connecting picture")}</span></div>}
            {thumbnail && <button className="c3-thumbnail-focus" type="button" aria-label={copy(`聚焦 ${title}`, `Focus ${title}`)}
              onClick={() => onFocus(source.id)} />}
            <footer>
              <div className="c3-monitor-source-row">
                <PawnSvg color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
                <div className="c3-monitor-source">
                  <Tooltip overflow={{ text: title, selector: "strong" }}><strong>{title}</strong></Tooltip>
                  <Tooltip overflow={{ text: sourceDetail, selector: "small" }}><small>
                    <span>{source.localSource ? copy("本机预览", "Local preview") : source.name}</span><span aria-hidden="true"> / </span>
                    {source.onRoom ? <button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button> : source.roomName}
                  </small></Tooltip>
                </div>
                <div className="c3-monitor-social">
                  <ChannelContentReactions reactions={source.reactions} session={source.interaction ?? null}
                    target={{ publicationId: source.id }} disabled={source.available === false} effectsEnabled={!source.hidden && !thumbnail}
                    effectAnchor={() => grid.current?.querySelector(`[data-publication-id="${CSS.escape(source.id)}"] .c3-monitor-source-row > .lr-person`) ?? null} />
                  <SourceAudience people={source.audience} />
                </div>
                <div className="c3-monitor-tile-actions">
                  {source.owned && source.shareControls}
                  {active.length > 1 && <Btn icon={isFocused ? "screenGrid" : "screenFocus"} quiet size="dense"
                      title={{ text: isFocused ? copy("返回平铺", "Return to grid") : copy(`聚焦 ${title}`, `Focus ${title}`) }}
                      hint={isFocused ? "hint-screen-grid" : "hint-screen-focus"}
                      pressed={isFocused} onClick={() => onFocus(isFocused ? null : source.id)} />}
                  {source.owned && microphone && <VoiceMicrophoneButton active={microphone.enabled}
                    quiet busy={microphone.busy && !(microphone.enabled && microphone.canDisable)}
                    disabled={(microphone.disabled || microphone.busy) && !(microphone.enabled && microphone.canDisable)}
                    hint={microphone.enabled ? "hint-microphone-off" : "hint-microphone-on"}
                    onClick={() => microphone.onEnabled(!microphone.enabled)} />}
                  {source.owned && <Btn icon={source.paused ? "play" : "pause"} quiet size="dense"
                    title={{ text: t(source.paused ? "host.resume" : "host.pause") + (source.pauseAvailable === false
                      ? copy("（重新连接后可用）", " (available after reconnecting)") : "") }} pressed={source.paused}
                    disabled={source.pauseAvailable === false || source.pausePending}
                    hint={source.paused ? "hint-resume" : "hint-pause"} busy={source.pausePending}
                    onClick={() => onPause(source.id, !source.paused)} />}
                  {source.owned && source.remoteControl && <SourceControl source={{ ...source, remoteControl: source.remoteControl }}
                    onInputPolicy={onInputPolicy} onInputDecide={onInputDecide} onInputSimultaneous={onInputSimultaneous} onInputShortcut={onInputShortcut} />}
                  <Btn icon={source.owned ? "stop" : "x"} tone={source.owned ? "danger" : undefined} quiet={!source.owned} size="dense"
                    title={{ text: source.owned ? copy(`停止分享 ${title}`, `Stop sharing ${title}`)
                      : copy(`停止观看 ${title}`, `Stop watching ${title}`) }}
                    hint={source.owned ? "hint-share-stop" : "hint-close"} busy={source.pending} disabled={source.pending}
                    onClick={() => source.owned ? onStop(source.id) : onUnwatch(source.id)} />
                </div>
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
          role="group" aria-label={`${screenTitle(source, lang)} / ${source.name} / ${source.roomName}`}>
          <PawnSvg color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
          <div><strong>{screenTitle(source, lang)}</strong><small>{source.name}<span aria-hidden="true"> / </span>{source.onRoom ? <button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button> : source.roomName}{source.paused ? ` / ${t("host.paused")}` : ""}</small></div>
          <SourceAudience people={source.audience} />
          <ChannelAction icon="eye" label={copy("观看", "Watch")}
            hint="hint-watch"
            iconOnly={vis} disabled={!canSubscribe || source.available === false} busy={source.pending}
            onClick={() => onWatch(source.id)} />
        </div>)}
      </div>
    </section>}
  </section>;
}
