import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy, type Copy } from "../../ui/copy";
import { ChannelVideo, ChannelWatchVideo, WatchPeerAction, type WatchReceiving } from "./ChannelMedia";
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
import { screenTitle, type ScreenAudiencePerson, type AudiencePerson } from "../presentation";
import type { MessageReactions } from "../protocol";
import { ChannelContentReactions } from "./ChannelContentReactions";
import { BrandLoader } from "../../components/living/BrandMark";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";

interface SourceAudioControl {
  level: number; muted: boolean; hasAudio: boolean; available: boolean; busy: boolean;
  canMute?: boolean;
  onChange(settings: { level?: number; muted?: boolean }): void;
}

function SourceSound({ sound, title }: { sound: SourceAudioControl; title: string }) {
  const { t } = useCopy();
  const silent = sound.muted || sound.level === 0;
  const available = sound.hasAudio && sound.available;
  return <span className="c3-source-audio">
    <AudioVolumeMenu volume={sound.level} onVolume={level => sound.onChange({ level, muted: false })}
      label="host.shareVolume" heading={t("screen.sharedSound", { title })}
      disabled={!available || sound.busy}>
      <Btn icon={!sound.hasAudio || silent ? "speakerOff" : "speaker"} quiet size="dense"
        title={!sound.hasAudio ? "playback.noAudio" : !sound.available ? "host.shareVolume.unavailable"
          : silent ? "host.shareVolume.unmute" : "host.shareVolume.mute"}
        disabled={!available || sound.busy && !(sound.canMute && !silent)} pressed={silent}
        onClick={() => sound.onChange({ level: sound.level || 1, muted: !silent })} />
    </AudioVolumeMenu>
  </span>;
}

export interface ScreenStageSource {
  kind: "screen";
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

export interface WatchStageSource {
  kind: "watch";
  id: string; userId: string; name: string; title: string; roomName: string; avatar?: string;
  owned: boolean; subscribed: boolean; hidden?: boolean; paused: boolean; pending?: boolean; available?: boolean;
  shareControls?: ReactNode;
  player?: import("../watch-playback").WatchPlayer;
  website: boolean; browserSource: boolean; originalPageAvailable: boolean; onAppWatch?: () => void; onFocusWindow(): void;
  receiving?: WatchReceiving;
  audience: readonly AudiencePerson[];
  onRoom(): void; onJoin(): void; onLeave(): void; onStop(): void; onResume(): void;
  onPlayback(patch: Partial<Pick<import("../protocol").WatchPlayback, "paused" | "position" | "rate">>): void;
}
export type ChannelStageSource = ScreenStageSource | WatchStageSource;
const stageTitle = (source: ChannelStageSource, t: Copy["t"]) => source.kind === "watch" ? source.title : screenTitle(source, t);

export function SourceAudience({ people, joined = false }: { people: readonly ScreenAudiencePerson[]; joined?: false } | { people: readonly AudiencePerson[]; joined: true }) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above", align: "end", maxHeight: 360 });
  const count = joined ? people.length : people.filter(person => "state" in person && person.state === "active").length;
  return <span ref={trigger} className="c3-screen-audience">
    <Btn icon="eye" iconOverlay={<span aria-hidden="true">{count}</span>} quiet size="dense" expanded={open} controls={id} popoverTarget={id}
      title={{ text: t(joined ? "watch.viewersCount" : "screen.viewersCount", { count: String(count) }) }} />
    <div id={id} ref={panel} popover="auto" role="dialog" aria-label={t(joined ? "watch.joined" : "screen.viewers")}
      className="lr-anchored-card c3-screen-audience-panel" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <h3>{t(joined ? "watch.joined" : "screen.viewers")}</h3>
      {people.length ? people.map(person => <ChannelUser key={person.userId} id={person.userId} name={person.name} avatar={person.avatar}
        self={false} owner={false} online activity={joined ? t("watch.joined") : "state" in person
          ? person.state === "active" ? t("screen.watching") : person.state === "preparing" ? t("screen.connecting") : t("screen.retrying") : undefined} />)
        : <p>{t(joined ? "watch.noViewers" : "screen.noViewers")}</p>}
    </div>
  </span>;
}

export interface ChannelStageProps {
  buffering?: import("../../components/living/PlaybackSettings").PlaybackSettingsProps["buffering"];
  sources: ChannelStageSource[];
  focusedId: string | null;
  canSubscribe: boolean;
  onFocus: (id: string | null) => void;
  onWatch: (id: string) => void;
  onUnwatch: (id: string) => void;
  onRetryPicture?: (id: string) => void;
  onPause: (id: string, paused: boolean) => void;
  onStop: (id: string) => void;
  onPresentation?: (flowId: string, stream: MediaStream, state: ScreenPresentation) => void;
  onInputPolicy: (publicationId: string, mode: RemoteControlMode, password?: string) => Promise<void>;
  onInputDecide: (publicationId: string, requestId: string, allow: boolean) => Promise<void>;
  onInputSimultaneous: (publicationId: string, enabled: boolean) => Promise<void>;
  onInputShortcut: (publicationId: string, key?: number) => Promise<ChannelStopShortcut>;
}

function SourceControl({ source, onInputPolicy, onInputDecide, onInputSimultaneous, onInputShortcut }: {
  source: ScreenStageSource & { remoteControl: NonNullable<ScreenStageSource["remoteControl"]> };
} & Pick<ChannelStageProps, "onInputPolicy" | "onInputDecide" | "onInputSimultaneous" | "onInputShortcut">) {
  const shortcut = useCallback((key?: number) => onInputShortcut(source.id, key), [onInputShortcut, source.id]);
  return <HostRemoteControl {...source.remoteControl} iconOnly size="dense"
    onPolicy={(mode, password) => onInputPolicy(source.id, mode, password)}
    onDecide={(id, allow) => onInputDecide(source.id, id, allow)}
    onShortcut={source.remoteControl.canSetStopShortcut ? shortcut : undefined}
    onSimultaneous={enabled => onInputSimultaneous(source.id, enabled)} />;
}

/** Subscription belongs to the caller. Focus only changes the layout of existing players. */
export function ChannelStage({ buffering, sources, focusedId, canSubscribe, onFocus, onWatch, onUnwatch, onRetryPicture, onPause, onStop, onPresentation,
  onInputPolicy, onInputDecide, onInputSimultaneous, onInputShortcut }: ChannelStageProps) {
  const { lang, t } = useCopy();
  const retained = sources.filter(source => source.owned || source.subscribed);
  const active = retained.filter(source => !source.hidden);
  const available = sources.filter(source => !source.hidden && !source.owned && !source.subscribed);
  const focused = active.find(source => source.id === focusedId);
  const automaticEmbed = (focused?.kind === "watch" && focused.player?.presentation.kind === "embed" ? focused
    : active.find(source => source.kind === "watch" && source.player?.presentation.kind === "embed"))?.id;
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
      const layout = getComputedStyle(tiles);
      const frame = tiles.querySelector<HTMLElement>('article:not([hidden]) > .c3-video, article:not([hidden]) > .c3-monitor-wait');
      const frameStyle = frame && getComputedStyle(frame);
      const [ratioWidth, ratioHeight = 1] = frameStyle?.aspectRatio.split("/").map(Number) ?? [];
      const natural = layout.gridAutoRows === "auto" && frameStyle ? {
        ratio: ratioWidth / ratioHeight || 0,
        insetX: parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.borderRightWidth) + parseFloat(frameStyle.paddingLeft) + parseFloat(frameStyle.paddingRight),
        insetY: parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.borderBottomWidth) + parseFloat(frameStyle.paddingTop) + parseFloat(frameStyle.paddingBottom),
        minHeight: parseFloat(frameStyle.minHeight) || 0,
      } : undefined;
      // A natural grid's height is its output; neither it nor page scrolling sets its budget.
      const availableHeight = natural
        ? Math.max(160, window.innerHeight - (parent.getBoundingClientRect().top + window.scrollY))
        : parent.clientHeight;
      const height = availableHeight - padding - children.filter(child => child !== tiles).reduce((sum, child) => sum + child.offsetHeight, 0)
        - gap * (children.length - 1);
      const footer = Math.max(...[...tiles.querySelectorAll("article:not([hidden]) > footer")].map(node => node.getBoundingClientRect().height)) + 2;
      const ratios = [...tiles.children].filter(tile => !(tile as HTMLElement).hidden).map(tile => {
        const video = tile.querySelector<HTMLVideoElement>('video[data-selected="true"]');
        return video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      });
      setColumns(stageColumns(tiles.clientWidth, height, ratios, parseFloat(layout.columnGap) || 0, footer,
        parseFloat(layout.getPropertyValue("--stage-tile-min")), natural));
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
  const hasFocusedMedia = focused?.kind === "watch" ? !!focused.player?.video : !!focused?.stream;
  useEffect(() => { if (!hasFocusedMedia) setTheater(false); }, [focused?.id, hasFocusedMedia, setTheater]);
  if (!sources.length) return null;

  return <section ref={stage} hidden={!active.length && !available.length} className={`c3-monitor${theater && focused ? " is-theater" : ""}`} aria-label={t("screen.sharedScreens")}>

    {retained.length > 0 && <>
      <header className="c3-monitor-heading" hidden={!active.length}>
        <div><Glyph name="tv" size={18} /><Cap k={{ text: t("screen.screens") }} /><small>{active.length}</small></div>
        {active.length > 1 && <div className="c3-monitor-layout">
          {focused && <label className="c3-theater-source">
            <select className="lr-select" aria-label={t("screen.switchScreen")} value={focused.id} onChange={event => onFocus(event.target.value)}>
              {active.map(source => <option key={source.id} value={source.id}>{stageTitle(source, t)} / {source.name} / {source.roomName}</option>)}
            </select></label>}
          <div className="lr-toggle" role="group" aria-label={t("screen.layout")}>
            <Tooltip kind="hint-screen-grid" text={t("screen.gridView")}>
              <button type="button" className={!focused ? "is-selected" : undefined} aria-pressed={!focused}
                aria-label={t("screen.gridView")} onClick={() => onFocus(null)}>
                <Glyph name="screenGrid" size={16} /><span>{t("screen.grid")}</span>
              </button>
            </Tooltip>
            <Tooltip kind="hint-screen-focus" text={t("screen.focusView")}>
              <button type="button" className={focused ? "is-selected" : undefined} aria-pressed={!!focused}
                aria-label={t("screen.focusView")} onClick={() => onFocus(focused?.id ?? active[0].id)}>
                <Glyph name="screenFocus" size={16} /><span>{t("screen.focus")}</span>
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
          if (source.kind === "watch") return <WatchStageTile key={source.id} source={source} thumbnail={thumbnail} focused={isFocused} automaticPlayback={source.id === automaticEmbed}
            focusable={focusable} centeredStart={centeredStart} onFocus={onFocus} theaterMode={theater && isFocused}
            onToggleTheater={() => { onFocus(source.id); setTheater(!theater); }} />;
          const microphone = source.sourceMicrophone;
          const sourceDetail = `${source.name} / ${source.roomName}${source.localSource ? ` / ${t("screen.localPreview")}` : ""}`;
          const title = screenTitle(source, t);
          return <article key={source.id} hidden={source.hidden} inert={source.hidden} className={`c3-monitor-tile${isFocused ? " is-focused" : ""}${thumbnail ? " is-thumbnail" : ""}`}
            style={centeredStart ? { gridColumn: `${centeredStart} / span 2` } : undefined}
            data-publication-id={source.id} data-focusable={focusable || undefined}
            aria-label={`${title} / ${source.name} / ${source.roomName}`}
            onClick={event => {
              if (!focusable || (event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) return;
              onFocus(source.id);
            }}>
            {source.stream ? <ChannelVideo buffering={buffering} stream={source.stream} owned={source.owned} localSource={source.localSource}
              onRetryPicture={onRetryPicture ? () => onRetryPicture(source.id) : undefined} retryAvailable={canSubscribe && !source.pending}
              presentation={source.hidden ? "background" : thumbnail ? "thumbnail" : "full"} inputs={source.inputs} onPresentation={onPresentation} input={source.input}
              interaction={source.interaction}
              theaterMode={theater && isFocused} onToggleTheater={() => {
                onFocus(source.id); setTheater(!theater);
              }}
              label={`${title} / ${source.name} / ${source.roomName}`} />
              : <div className="c3-monitor-wait" data-failed={!source.paused && source.deliveryFailed || undefined} role="status">
                {source.paused || source.deliveryFailed ? <Glyph name={source.paused ? "pause" : "x"} size={24} /> : <BrandLoader />}
                <span>{source.paused ? t("host.pauseNotice") : source.deliveryFailed
                  ? t("screen.deliveryRetry")
                  : t("screen.connectingPicture")}</span>
                {!source.owned && !source.localSource && onRetryPicture && <Btn icon="refresh" size="compact" quiet
                  title="screen.retryPicture" cap="screen.retryPicture" disabled={!canSubscribe || source.pending}
                  onClick={() => onRetryPicture(source.id)} />}</div>}
            <footer>
              <div className="c3-monitor-source-row" data-tooltip-controls>
                <PawnSvg color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
                <div className="c3-monitor-source">
                  <Tooltip overflow={{ text: title, selector: "strong" }}><strong>{title}</strong></Tooltip>
                  <Tooltip overflow={{ text: sourceDetail, selector: "small" }}><small>
                    <span>{source.localSource ? t("screen.localPreview") : source.name}</span><span aria-hidden="true"> / </span>
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
                  {active.length > 1 && <Tooltip className="c3-monitor-layout-action" kind={isFocused ? "hint-screen-grid" : "hint-screen-focus"}
                    text={isFocused ? t("screen.returnToGrid") : t("screen.focusNamed", { title })}><Btn icon={isFocused ? "screenGrid" : "screenFocus"} quiet size="dense"
                      title={{ text: isFocused ? t("screen.returnToGrid") : t("screen.focusNamed", { title }) }}
                      pressed={isFocused} onClick={() => onFocus(isFocused ? null : source.id)} /></Tooltip>}
                  {source.owned && <div className="c3-monitor-publishing" role="group"
                    aria-label={t("screen.sharingControls", { title })}>
                    {source.shareControls}
                    {source.sourceAudio && <SourceSound sound={source.sourceAudio} title={title} />}
                    {microphone && <VoiceMicrophoneButton active={microphone.enabled}
                      quiet busy={microphone.busy && !(microphone.enabled && microphone.canDisable)}
                      disabled={(microphone.disabled || microphone.busy) && !(microphone.enabled && microphone.canDisable)}
                      hint={microphone.enabled ? "hint-microphone-off" : "hint-microphone-on"}
                      onClick={() => microphone.onEnabled(!microphone.enabled)} />}
                    <Btn icon={source.paused ? "play" : "pause"} quiet size="dense"
                      title={{ text: source.pauseAvailable === false
                        ? t("screen.actionAfterReconnect", { action: t(source.paused ? "host.resume" : "host.pause") })
                        : t(source.paused ? "host.resume" : "host.pause") }} pressed={source.paused}
                      disabled={source.pauseAvailable === false || source.pausePending}
                      hint={source.paused ? "hint-resume" : "hint-pause"} busy={source.pausePending}
                      onClick={() => onPause(source.id, !source.paused)} />
                    {source.remoteControl && <SourceControl source={{ ...source, remoteControl: source.remoteControl }}
                      onInputPolicy={onInputPolicy} onInputDecide={onInputDecide} onInputSimultaneous={onInputSimultaneous} onInputShortcut={onInputShortcut} />}
                    <span className="c3-monitor-close"><Btn icon="stop" tone="danger" size="dense"
                      title={{ text: t("screen.stopSharing", { title }) }}
                      hint="hint-share-stop" busy={source.pending} disabled={source.pending} onClick={() => onStop(source.id)} /></span>
                  </div>}
                  {!source.owned && <span className="c3-monitor-close"><Btn icon="x" quiet size="dense"
                    title={{ text: t("screen.stopWatching", { title }) }}
                    hint="hint-close" busy={source.pending} disabled={source.pending} onClick={() => onUnwatch(source.id)} /></span>}
                </div>
              </div>
            </footer>
          </article>;
        })}
      </div>
    </>}
    {available.length > 0 && <section className="c3-monitor-directory" aria-label={t("screen.availableScreens")}>
      <div className="c3-monitor-directory-heading"><Glyph name="tv" size={17} />
        <Cap k={{ text: t("screen.availableToWatch") }} /><small>{available.length}</small>
      </div>
      <div className="c3-monitor-offers">
        {available.map(source => <div key={source.id} className="c3-monitor-offer" data-source-id={source.id}
          role="group" aria-label={`${stageTitle(source, t)} / ${source.name} / ${source.roomName}`}>
          <div className="c3-monitor-offer-identity">
            <PawnSvg color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
            <div><strong>{stageTitle(source, t)}</strong><small>{source.name}<span aria-hidden="true"> / </span>{source.onRoom ? <button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button> : source.roomName}{source.paused ? ` / ${t("host.paused")}` : ""}</small></div>
          </div>
          {source.kind === "watch" ? <SourceAudience people={source.audience} joined /> : <SourceAudience people={source.audience} />}
          <div className="c3-monitor-offer-actions">
            {source.kind === "watch" && !source.browserSource ? source.receiving?.peerAvailable && source.receiving.peerSupported ? null : source.onAppWatch
              ? <ChannelAction icon="window" label={t("watch.inApp")} disabled={!canSubscribe || source.available === false} busy={source.pending} onClick={source.onAppWatch} />
              : source.originalPageAvailable && <small>{t("watch.connectApp")}</small> : <ChannelAction icon="eye" label={t("screen.watch")}
              hint="hint-watch"
              disabled={!canSubscribe || source.available === false} busy={source.pending}
              onClick={() => source.kind === "watch" ? source.onJoin() : onWatch(source.id)} />}
            {source.kind === "watch" && source.receiving && <WatchPeerAction receiving={source.receiving} />}
          </div>
        </div>)}
      </div>
    </section>}
  </section>;
}

function WatchStageTile({ source, thumbnail, focused, focusable, centeredStart, onFocus, theaterMode, onToggleTheater, automaticPlayback }: {
  source: WatchStageSource; thumbnail: boolean; focused: boolean; focusable: boolean; centeredStart?: number;
  onFocus(id: string | null): void; theaterMode: boolean; onToggleTheater(): void;
  automaticPlayback: boolean;
}) {
  const { t } = useCopy();
  const embedded = source.player?.presentation.kind === "embed";
  return <article hidden={source.hidden} inert={source.hidden} data-embed={source.player?.presentation.kind === "embed" || undefined} data-publication-id={source.id} data-source-kind="watch" data-watch-mode={source.receiving?.mode} data-focusable={focusable || undefined}
    className={`c3-monitor-tile${focused ? " is-focused" : ""}${thumbnail ? " is-thumbnail" : ""}`}
    style={centeredStart ? { gridColumn: `${centeredStart} / span 2` } : undefined}
    aria-label={`${source.title} / ${source.name} / ${source.roomName}`} onClick={event => {
      if (focusable && !(event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) onFocus(source.id);
    }}>
    {source.player ? <ChannelWatchVideo player={source.player} owned={source.owned} paused={source.paused} label={source.title}
      website={source.website} originalPageAvailable={source.originalPageAvailable} onAppWatch={source.onAppWatch} onFocusWindow={source.onFocusWindow}
      receiving={source.receiving} automaticPlayback={automaticPlayback}
      disabled={source.available === false} presentation={source.hidden ? "background" : thumbnail ? "thumbnail" : "full"}
      theaterMode={theaterMode} onToggleTheater={onToggleTheater}
      onPlayback={patch => { if (embedded && patch.paused === false) onFocus(source.id); source.onPlayback(patch); }}
      onResume={() => {
        if (embedded) {
          onFocus(source.id);
          if (source.player?.presentation.kind === "embed") source.player.presentation.element.scrollIntoView({ block: "nearest" });
        }
        source.onResume();
      }} />
      : <div className="c3-monitor-wait" role="status">{source.website && !source.pending ? <><Glyph name="globe" size={25} /><span>{t("watch.browserFailed")}</span>
        {!source.owned && source.originalPageAvailable && (source.onAppWatch
          ? <Btn icon="window" title="watch.inApp" cap="watch.inApp" onClick={source.onAppWatch} />
          : !(source.receiving?.peerAvailable && source.receiving.peerSupported) && <small>{t("watch.connectApp")}</small>)}
        {source.receiving && <WatchPeerAction receiving={source.receiving} />}</>
        : <><BrandLoader /><span>{t("watch.waiting")}</span></>}</div>}
    <footer><div className="c3-monitor-source-row" data-tooltip-controls>
      <PawnSvg color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
      <div className="c3-monitor-source"><Tooltip overflow={{ text: source.title, selector: "strong" }}><strong>{source.title}</strong></Tooltip>
        <small>{source.name}<span aria-hidden="true"> / </span><button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button></small>
      </div>
      <div className="c3-monitor-tile-actions">
        <SourceAudience people={source.audience} joined />
        {(focusable || focused) && <Tooltip className="c3-monitor-layout-action" kind={focused ? "hint-screen-grid" : "hint-screen-focus"}
          text={focused ? t("screen.returnToGrid") : t("screen.focusNamed", { title: source.title })}><Btn icon={focused ? "screenGrid" : "screenFocus"} quiet size="dense"
          title={{ text: focused ? t("screen.returnToGrid") : t("screen.focusNamed", { title: source.title }) }}
          pressed={focused} onClick={() => onFocus(focused ? null : source.id)} /></Tooltip>}
        {source.owned ? <div className="c3-monitor-publishing" role="group" aria-label={t("screen.sharingControls", { title: source.title })}>
          {source.shareControls}
          <span className="c3-monitor-close"><Btn icon="stop" tone="danger" size="dense"
            title="watch.stop" busy={source.pending} disabled={source.pending || source.available === false} onClick={source.onStop} /></span>
        </div> :
        <span className="c3-monitor-close"><Btn icon="x" quiet size="dense"
          title="watch.leave" busy={source.pending} disabled={source.pending || source.available === false}
          onClick={source.onLeave} /></span>}
      </div>
    </div></footer>
  </article>;
}
