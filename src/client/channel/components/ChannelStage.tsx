import { createPortal } from "react-dom";
import { useStagePicture, type StagePictureSource } from "./use-stage-picture";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy, type Copy } from "../../ui/copy";
import { ChannelVideo, ChannelWatchVideo, PictureFailure, WatchPeerAction, type WatchReceiving } from "./ChannelMedia";
import { ChannelAction } from "./ChannelAction";
import type { ChannelActions, ChannelScreenInput } from "../types";
import type { ScreenPlaybackError } from "../../media/viewer-playback";
import "./channel-stage.css";
import type { InputTransport } from "../../remote-control/input-route";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import type { RemoteControlMode } from "../../remote-control/protocol";
import type { ChannelRemoteControlState, ChannelStopShortcut } from "../app-link";
import { HostRemoteControl } from "../../components/living/HostRemoteControl";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { stageFocusSidebar, fittedStage, type StageTile } from "../stage-layout";
import type { useTheaterMode } from "../../components/living/use-theater-mode";
import { VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { Btn, Cap } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { ChannelUser } from "./ChannelUser";
import { participantViewingLabel, screenTitle, viewingAppearance, type ScreenAudiencePerson, type AudiencePerson } from "../presentation";
import type { MessageReactions } from "../protocol";
import { ChannelContentReactions } from "./ChannelContentReactions";
import { BrandLoader } from "../../components/living/BrandMark";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { ChannelSettingsDialog, useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelDiagnosisHelp } from "./ChannelDiagnosisHelp";
import { diagnoseChannelFact, type ChannelDiagnosis } from "../diagnosis";
import { Comic } from "../../components/living/Comic";

function PictureDeliveryHelp({ diagnosis, admitted, playbackFailed, routeFailed, onRetry }: {
  diagnosis: ChannelDiagnosis; admitted: boolean | undefined; playbackFailed: boolean; routeFailed: boolean; onRetry?: () => void;
}) {
  const { t } = useCopy();
  const [open, setOpen] = useState(false);
  return <>
    <ChannelAction icon="help" label={t("screen.pictureHelp")} iconOnly quiet onClick={() => setOpen(true)} />
    {open && <ChannelSettingsDialog compact title={t("screen.pictureHelp")} onClose={() => setOpen(false)}>
      <div className="c3-settings-panels c3-diagnosis-result">
        {routeFailed && <Comic kind="route-failed" theme="paper" />}
        <p className="c3-diagnosis-verdict">{t(diagnosis.message)}</p>
        {onRetry && diagnosis.next && <Btn icon="refresh" size="compact" tone="primary"
          title={diagnosis.next} cap={diagnosis.next}
          onClick={() => { setOpen(false); onRetry(); }} />}
        <ChannelDiagnosisHelp diagnosis={diagnosis} details={admitted && !playbackFailed ? ["diagnosis.roomAdmitted"] : undefined} />
      </div>
    </ChannelSettingsDialog>}
  </>;
}

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
        disabled={!available || sound.busy && !(sound.canMute && !silent)} tone={silent ? "on" : undefined}
        onClick={() => sound.onChange({ level: sound.level || 1, muted: !silent })} />
    </AudioVolumeMenu>
  </span>;
}

export interface ScreenStageSource extends StagePictureSource {
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
  playbackError?: ScreenPlaybackError;
  /** The last Watch or Retry picture failure, shown wherever this picture currently is. */
  pictureFailure?: string;
  clearPictureFailure?(): void;
  roomAdmitted?: boolean;
  deliveryScope?: string;
  waitingForInput?: boolean;
  stream?: MediaStream;
  sourceAudio?: SourceAudioControl;
  shareControls?: (actions: ReactNode, compact: boolean) => ReactNode;
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

export interface WatchStageSource extends StagePictureSource {
  actionFailure?: string;
  clearActionFailure?(): void;
  awaitingSource?: boolean;
  kind: "watch";
  id: string; userId: string; name: string; title: string; roomName: string; avatar?: string;
  owned: boolean; subscribed: boolean; hidden?: boolean; paused: boolean; pending?: boolean; available?: boolean;
  shareControls?: ReactNode;
  player?: import("../watch-playback").WatchPlayer;
  website: boolean; browserSource: boolean; originalPageAvailable: boolean; onAppWatch?: () => void; onFocusWindow(): Promise<void>;
  originalPageUnavailable?: string;
  receiving?: WatchReceiving;
  audience: readonly AudiencePerson[];
  onRoom(): void; onJoin(): void; onLeave(): void; onStop(): void; onResume(): Promise<void>;
  onPlayback(patch: Partial<Pick<import("../protocol").WatchPlayback, "paused" | "position" | "rate">>): Promise<void>;
}
export interface WaitingStageSource {
  roomId?: string;
  kind: "waiting"; id: string; userId: string; name: string; title: string; roomName: string; avatar?: string;
  hidden?: boolean; onClose(): void;
}
export type ChannelStageSource = ScreenStageSource | WatchStageSource | WaitingStageSource;
/** A picture's surface lives while it has any live input, so a moment without a selection keeps its candidate. */
const hasPicture = (source: ScreenStageSource) => !!source.stream || !!source.inputs?.length;
const stageTitle = (source: ChannelStageSource, t: Copy["t"]) => source.kind === "screen" ? screenTitle(source, t) : source.title;

function stagePictureRatio(tile: Element) {
  const video = tile.querySelector<HTMLVideoElement>('video[data-selected="true"]');
  return video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
}

function SourceOfferAction({ source, disabled, onWatch }: {
  source: ScreenStageSource | WatchStageSource; disabled: boolean; onWatch(id: string): void;
}) {
  const { t } = useCopy();
  let join = () => onWatch(source.id);
  if (source.kind === "watch") {
    const { receiving } = source;
    if (source.browserSource) join = source.onJoin;
    else if (source.onAppWatch) return <>
      <ChannelAction icon="window" label={t("watch.openPage")}
        disabled={disabled} busy={source.pending} onClick={source.onAppWatch} />
      {receiving?.peerAvailable && receiving.peerSupported && <ChannelAction icon="share" label={t("watch.forward.peer")} quiet
        disabled={disabled || receiving.disabled} busy={source.pending} onClick={receiving.onPeer} />}
    </>;
    else if (receiving?.peerAvailable && receiving.peerSupported) join = receiving.onPeer;
    else {
      const hint = receiving?.peerAvailable ? t("watch.forward.secure")
        : source.originalPageUnavailable ?? (source.originalPageAvailable ? t("watch.connectApp") : undefined);
      return hint ? <small>{hint}</small> : null;
    }
  }
  return <ChannelAction icon="eye" label={t("screen.watch")} hint="hint-watch"
    disabled={disabled} busy={source.pending} onClick={join} />;
}

export function SourceAudience({ people, joined = false }: { people: readonly ScreenAudiencePerson[]; joined?: false } | { people: readonly AudiencePerson[]; joined: true }) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above", align: "end", maxHeight: 360 });
  const count = joined ? people.length : people.filter(person => "state" in person && person.state === "active").length;
  return <span ref={trigger} className="c3-screen-audience">
    <Btn icon={joined ? viewingAppearance.joined.icon : "eye"} iconOverlay={<span aria-hidden="true">{count}</span>} quiet size="dense" expanded={open} controls={id} popoverTarget={id}
      title={{ text: t(joined ? "watch.viewersCount" : "screen.viewersCount", { count: String(count) }) }} />
    <div id={id} ref={panel} popover="auto" role="dialog" aria-label={t(joined ? "watch.joined" : "screen.viewers")}
      className="lr-anchored-card c3-screen-audience-panel" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <h3>{t(joined ? "watch.joined" : "screen.viewers")}</h3>
      {people.length ? people.map(person => <ChannelUser key={person.userId} id={person.userId} name={person.name} avatar={person.avatar}
        self={false} owner={false} online activity={joined ? t("watch.joined") : "state" in person
          ? participantViewingLabel(person.state, t) : undefined} />)
        : <p>{t(joined ? "watch.noViewers" : "screen.noViewers")}</p>}
    </div>
  </span>;
}

export interface ChannelStageProps {
  layoutHome?: HTMLElement | null;
  /** Measure the settled living-room area before painting a companion change. */
  companion: "chat" | "people" | "none";
  theaterMode: ReturnType<typeof useTheaterMode>;
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
  onPresentation?: ChannelActions["screenPresentation"];
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
export function ChannelStage({ layoutHome, companion, theaterMode: [theater, setTheater], buffering, sources, focusedId, canSubscribe, onFocus: onChangeFocus, onWatch, onUnwatch, onRetryPicture, onPause, onStop, onPresentation,
  onInputPolicy, onInputDecide, onInputSimultaneous, onInputShortcut }: ChannelStageProps) {
  const { lang, t } = useCopy();
  const retained = sources.filter(source => source.kind === "waiting" || source.owned || source.subscribed);
  const active = retained.filter(source => !source.hidden);
  const available = sources.filter((source): source is ScreenStageSource | WatchStageSource => source.kind !== "waiting" && !source.hidden && !source.owned && !source.subscribed);
  const focused = active.find(source => source.id === focusedId);
  const automaticEmbed = (focused?.kind === "watch" && focused.player?.presentation.kind === "embed" ? focused
    : active.find(source => source.kind === "watch" && source.player?.presentation.kind === "embed"))?.id;
  const layoutSources = JSON.stringify([active.map(source => source.id), available.map(source => source.id)]);
  const stage = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null);
  useStagePicture(stage, sources);
  const pendingFocus = useRef<{ id: string; trigger: Element | null } | null>(null);
  const onFocus = (id: string | null) => {
    pendingFocus.current = id && id !== focused?.id
      ? { id, trigger: document.activeElement?.closest(".c3-monitor-layout-action button") ?? null }
      : null;
    onChangeFocus(id);
  };
  const [columns, setColumns] = useState<number>();
  const fitGrid = !theater && (!focused || active.length === 1);
  const [tileSizes, setTileSizes] = useState<StageTile[]>();
  const [sideStrip, setSideStrip] = useState(false);
  useLayoutEffect(() => {
    const parent = stage.current, tiles = grid.current;
    if (!parent || !tiles || theater || !active.length) { setColumns(undefined); setSideStrip(false); setTileSizes(undefined); return; }
    const measure = () => {
      const style = getComputedStyle(parent), children = [...parent.children].filter(child => getComputedStyle(child).display !== "none") as HTMLElement[];
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const gap = parseFloat(style.rowGap) || 0;
      const layout = getComputedStyle(tiles);
      if (focused && !fitGrid) {
        const main = tiles.querySelector<HTMLElement>("article.is-focused")!;
        const thumbs = [...tiles.querySelectorAll<HTMLElement>("article.is-thumbnail")];
        setSideStrip(stageFocusSidebar(tiles.clientWidth, tiles.clientHeight,
          stagePictureRatio(main),
          main.querySelector("footer")!.offsetHeight + 2, parseFloat(layout.columnGap) || 0,
          thumbs.map(tile => tile.getBoundingClientRect()), parseFloat(layout.getPropertyValue("--stage-tile-min"))));
        return;
      }
      const availableHeight = style.maxHeight.endsWith("px") && style.flexGrow === "0" ? parseFloat(style.maxHeight) : parent.clientHeight;
      const height = availableHeight - padding - children.filter(child => child !== tiles).reduce((sum, child) => sum + child.offsetHeight, 0)
        - gap * (children.length - 1);
      const footer = Math.max(...[...tiles.querySelectorAll("article:not([hidden]) > footer")].map(node => node.getBoundingClientRect().height));
      const ratios = [...tiles.children].filter(tile => !(tile as HTMLElement).hidden).map(stagePictureRatio);
      const tileGap = parseFloat(layout.columnGap) || 0;
      const minimumWidth = parseFloat(layout.getPropertyValue("--stage-tile-min"));
      const fitted = fittedStage(tiles.clientWidth, height, ratios, tileGap, footer, minimumWidth);
      setColumns(fitted.columns);
      setTileSizes(fitted.tiles);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (fitGrid && parent.parentElement) observer.observe(parent.parentElement);
    if (focused && !fitGrid) {
      observer.observe(tiles);
      for (const thumb of tiles.querySelectorAll("article.is-thumbnail")) observer.observe(thumb);
    }
    const selection = new MutationObserver(measure);
    selection.observe(tiles, { subtree: true, attributes: true, attributeFilter: ["data-selected"] });
    for (const child of parent.children) if (child !== tiles) observer.observe(child);
    for (const footer of tiles.querySelectorAll("article > footer")) observer.observe(footer);
    tiles.addEventListener("loadedmetadata", measure, true);
    tiles.addEventListener("resize", measure, true);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      selection.disconnect();
      tiles.removeEventListener("loadedmetadata", measure, true);
      tiles.removeEventListener("resize", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [layoutSources, focused?.id, theater, lang, companion, layoutHome, fitGrid]);
  useLayoutEffect(() => {
    for (const tile of grid.current?.querySelectorAll<HTMLElement>('article[hidden], article.is-thumbnail') ?? []) {
      for (const panel of tile.querySelectorAll<HTMLElement>('[popover]:popover-open')) panel.hidePopover();
    }
  }, [layoutSources, focused?.id]);
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    pendingFocus.current = null;
    const tiles = grid.current;
    if (!tiles || !request || request.id !== focused?.id) return;
    // The focus button can scroll the strip down and disappears when its tile moves to the main row.
    tiles.scrollTop = 0;
    if (request.trigger && !request.trigger.isConnected && document.activeElement === document.body) {
      tiles.querySelector<HTMLElement>(".c3-monitor-tile.is-focused")?.focus({ preventScroll: true });
    }
  }, [focused?.id]);
  const hasFocusedMedia = focused?.kind === "watch" ? !!focused.player?.video : focused?.kind === "screen" && hasPicture(focused);
  useEffect(() => { if (!hasFocusedMedia) setTheater(false); }, [focused?.id, hasFocusedMedia, setTheater]);
  if (!sources.length) return null;
  const layoutInToolbar = layoutHome && !theater;
  const layoutControls = active.length > 1 && <div className="c3-monitor-layout">
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
  </div>;

  return <section ref={stage} hidden={!active.length && !available.length} className={`c3-monitor${theater && focused ? " is-theater" : ""}`} aria-label={t("screen.sharedScreens")}>

    {retained.length > 0 && <>
      <header className="c3-monitor-heading" hidden={!active.length || !!layoutInToolbar}>
        <div><Glyph name="tv" size={18} /><Cap k={{ text: t("screen.screens") }} /><small>{active.length}</small></div>
        {layoutInToolbar ? createPortal(layoutControls, layoutHome) : layoutControls}
      </header>
      <div ref={grid} data-fitted={fitGrid && !!tileSizes || undefined} data-side-strip={!fitGrid && !!focused && !theater && sideStrip || undefined} hidden={!active.length} className={`c3-monitor-grid${focused ? " is-focused" : active.length > 1 ? " is-grid" : ""}`}
        style={{ "--stage-columns": columns ?? 1, "--stage-thumbnails": Math.max(1, active.length - 1) } as CSSProperties}>
        {retained.map(source => {
          const index = active.indexOf(source);
          const isFocused = source.id === focused?.id;
          const thumbnail = !source.hidden && !!focused && !isFocused;
          const focusable = active.length > 1 && !isFocused;
          const remainder = active.length % (columns ?? 1);
          const centeredStart = !source.hidden && !focused && remainder && index === active.length - remainder ? (columns ?? 1) - remainder + 1 : undefined;
          const size = fitGrid ? tileSizes?.[index] : undefined;
          const compactCaption = !!size && size.width <= 480;
          const tileStyle = {
            gridColumn: centeredStart ? `${centeredStart} / span 2` : undefined,
            "--stage-picture-width": size && `${size.width}px`,
            "--stage-picture-height": size && `${size.height}px`,
          } as CSSProperties;
          if (source.kind === "watch") return <WatchStageTile key={source.id} source={source} thumbnail={thumbnail} focused={isFocused} automaticPlayback={source.id === automaticEmbed}
            compactCaption={compactCaption} focusable={focusable} style={tileStyle} onFocus={onFocus} theaterMode={theater && isFocused}
            onToggleTheater={() => { onFocus(source.id); setTheater(!theater); }} />;
          const waiting = source.kind === "waiting";
          const microphone = !waiting && source.sourceMicrophone;
          const sourceDetail = `${source.name} / ${source.roomName}${!waiting && source.localSource ? ` / ${t("screen.localPreview")}` : ""}`;
          const title = stageTitle(source, t);
          const playbackFailed = !waiting && source.playbackError !== undefined;
          const failed = !waiting && !source.paused && (playbackFailed || source.deliveryFailed);
          const diagnosis = !waiting && diagnoseChannelFact({ area: "screen", paused: source.paused,
            deliveryFailed: source.deliveryFailed, waitingForInput: source.waitingForInput, playbackError: source.playbackError });
          const retryable = failed || !waiting && !source.waitingForInput;
          const help = diagnosis && canSubscribe && !waiting && !source.pending && !source.hidden;
          const publishingActions = !waiting && source.owned && <>
            {source.sourceAudio && <SourceSound sound={source.sourceAudio} title={title} />}
            {microphone && <VoiceMicrophoneButton draw="voice-microphone" active={microphone.enabled}
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
          </>;
          return <article key={source.id} data-compact-caption={compactCaption || undefined} hidden={source.hidden} inert={source.hidden} tabIndex={isFocused ? -1 : undefined} className={`c3-monitor-tile${isFocused ? " is-focused" : ""}${thumbnail ? " is-thumbnail" : ""}`}
            style={tileStyle}
            data-publication-id={source.id} data-focusable={focusable || undefined} data-playback-controls-scope
            aria-label={`${title} / ${source.name} / ${source.roomName}`}
            onClick={event => {
              if (!focusable || (event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) return;
              onFocus(source.id);
            }}>
            {waiting ? <div className="c3-monitor-wait"><Glyph name="tv" size={24} /><span role="status">{t("screen.shareEnded", { name: source.name })}</span></div> : hasPicture(source) ? <ChannelVideo buffering={buffering} stream={source.stream} owned={source.owned} localSource={source.localSource} sourcePaused={source.paused}
              onRetryPicture={onRetryPicture ? () => onRetryPicture(source.id) : undefined} retryAvailable={canSubscribe && !source.pending}
              failure={source.pictureFailure} clearFailure={source.clearPictureFailure}
              presentation={source.hidden ? "background" : thumbnail ? "thumbnail" : "full"} inputs={source.inputs} onPresentation={onPresentation} input={source.input}
              interaction={source.interaction}
              theaterMode={theater && isFocused} onToggleTheater={() => {
                onFocus(source.id); setTheater(!theater);
              }}
              label={`${title} / ${source.name} / ${source.roomName}`} />
              : <div className="c3-monitor-wait" data-failed={failed || undefined}>
                {source.paused || failed || source.waitingForInput ? <Glyph name={source.paused ? "pause" : failed ? "x" : "tv"} size={24} /> : <BrandLoader />}
                <span role="status">{t(source.paused ? "host.pauseNotice" : playbackFailed && diagnosis ? diagnosis.message
                  : source.deliveryFailed ? "screen.deliveryRetry" : source.waitingForInput ? "screen.waitingPicture" : "screen.connectingPicture")}</span>
                {!source.paused && !source.owned && !source.localSource && (retryable || help) &&
                  <div className="c3-monitor-wait-actions">
                    {onRetryPicture && retryable && <Btn icon="refresh" size="compact" quiet
                      title="screen.retryPicture" cap="screen.retryPicture" disabled={!canSubscribe || source.pending}
                      onClick={() => onRetryPicture(source.id)} />}
                    {help && <PictureDeliveryHelp
                      key={source.deliveryScope} diagnosis={diagnosis} admitted={source.roomAdmitted} playbackFailed={playbackFailed}
                      routeFailed={!playbackFailed && !!source.deliveryFailed}
                      onRetry={onRetryPicture ? () => onRetryPicture(source.id) : undefined} />}
                  </div>}
                {source.pictureFailure && <PictureFailure error={source.pictureFailure} onDismiss={source.clearPictureFailure} />}</div>}
            <footer>
              <div className="c3-monitor-source-row" data-tooltip-controls>
                <div className="c3-monitor-source-info">
                  <PawnSvg centered color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
                  <div className="c3-monitor-source">
                    <Tooltip overflow={{ text: title, selector: "strong" }}><strong>{title}</strong></Tooltip>
                    <Tooltip overflow={{ text: sourceDetail, selector: "small" }}><small>
                      <span>{!waiting && source.localSource ? t("screen.localPreview") : source.name}</span><span aria-hidden="true"> / </span>
                      {!waiting && source.onRoom ? <button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button> : source.roomName}
                    </small></Tooltip>
                  </div>
                  {!waiting && <div className="c3-monitor-social">
                    <ChannelContentReactions reactions={source.reactions} session={source.interaction ?? null}
                      target={{ publicationId: source.id }} disabled={source.available === false} effectsEnabled={!source.hidden}
                      effectAnchor={() => grid.current?.querySelector(`[data-publication-id="${CSS.escape(source.id)}"] .c3-monitor-source-info > .lr-person`) ?? null} />
                    <SourceAudience people={source.audience} />
                  </div>}
                </div>
                <div className="c3-monitor-tile-actions">
                  {active.length > 1 && !isFocused && <Tooltip className="c3-monitor-layout-action" kind="hint-screen-focus"
                    text={t("screen.focusNamed", { title })}><Btn icon="screenFocus" quiet size="dense"
                      title={{ text: t("screen.focusNamed", { title }) }} onClick={() => onFocus(source.id)} /></Tooltip>}
                  {!waiting && source.owned && <div className="c3-monitor-publishing" role="group"
                    aria-label={t("screen.sharingControls", { title })}>
                    {source.shareControls ? !source.hidden && source.shareControls(publishingActions, compactCaption) : publishingActions}
                    {source.remoteControl && <SourceControl source={{ ...source, remoteControl: source.remoteControl }}
                      onInputPolicy={onInputPolicy} onInputDecide={onInputDecide} onInputSimultaneous={onInputSimultaneous} onInputShortcut={onInputShortcut} />}
                    <span className="c3-monitor-close"><Btn icon="stop" tone="danger" size="dense"
                      title={{ text: t("screen.stopSharing", { title }) }}
                      hint="hint-share-stop" busy={source.pending} disabled={source.pending} onClick={() => onStop(source.id)} /></span>
                  </div>}
                  {(waiting || !source.owned) && <span className="c3-monitor-close"><Btn icon="x" quiet size="dense"
                    title={{ text: t("screen.stopWatching", { title }) }}
                    hint="hint-close" busy={!waiting && source.pending} disabled={!waiting && source.pending} onClick={waiting ? source.onClose : () => onUnwatch(source.id)} /></span>}
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
            <PawnSvg centered color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
            <div><strong>{stageTitle(source, t)}</strong><small>{source.name}<span aria-hidden="true"> / </span>{source.onRoom ? <button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button> : source.roomName}{source.paused ? ` / ${t("host.paused")}` : ""}</small></div>
          </div>
          {source.kind === "watch" ? <SourceAudience people={source.audience} joined /> : <SourceAudience people={source.audience} />}
          <div className="c3-monitor-offer-actions" data-tooltip-controls>
            <SourceOfferAction source={source} disabled={!canSubscribe || source.available === false} onWatch={onWatch} />
          </div>
          {source.kind === "watch" && source.actionFailure && <PictureFailure error={source.actionFailure} onDismiss={source.clearActionFailure} />}
          {source.kind === "screen" && source.pictureFailure && <PictureFailure error={source.pictureFailure} onDismiss={source.clearPictureFailure} />}
        </div>)}
      </div>
    </section>}
  </section>;
}

function WatchStageTile({ source, thumbnail, compactCaption, focused, focusable, style, onFocus, theaterMode, onToggleTheater, automaticPlayback }: {
  source: WatchStageSource; thumbnail: boolean; compactCaption: boolean; focused: boolean; focusable: boolean; style: CSSProperties;
  onFocus(id: string | null): void; theaterMode: boolean; onToggleTheater(): void;
  automaticPlayback: boolean;
}) {
  const { t } = useCopy();
  const embedded = source.player?.presentation.kind === "embed";
  const playbackAction = useSettingsAction(!source.hidden, source.player);
  const windowAction = useSettingsAction(!source.hidden, source.player);
  return <article data-compact-caption={compactCaption || undefined} hidden={source.hidden} inert={source.hidden} tabIndex={focused ? -1 : undefined} data-embed={source.player?.presentation.kind === "embed" || undefined} data-publication-id={source.id} data-source-kind="watch" data-watch-mode={source.receiving?.mode} data-focusable={focusable || undefined} data-playback-controls-scope
    className={`c3-monitor-tile${focused ? " is-focused" : ""}${thumbnail ? " is-thumbnail" : ""}`}
    style={style}
    aria-label={`${source.title} / ${source.name} / ${source.roomName}`} onClick={event => {
      if (focusable && !(event.target instanceof Element && event.target.closest("button, input, select, a, [popover]"))) onFocus(source.id);
    }}>
    {source.player ? <ChannelWatchVideo player={source.player} owned={source.owned} paused={source.paused} label={source.title}
      actionFeedback={source.actionFailure || playbackAction.error || windowAction.error ? <>
        {source.actionFailure && <PictureFailure error={source.actionFailure} onDismiss={source.clearActionFailure} />}
        {playbackAction.error && <PictureFailure error={playbackAction.error} onDismiss={playbackAction.clearError} />}
        {windowAction.error && <PictureFailure error={windowAction.error} onDismiss={windowAction.clearError} />}
      </> : undefined}
      website={source.website} originalPageAvailable={source.originalPageAvailable} originalPageUnavailable={source.originalPageUnavailable} onAppWatch={source.onAppWatch} onFocusWindow={() => { void windowAction.run(source.onFocusWindow); }}
      receiving={source.receiving} retryPending={source.pending} automaticPlayback={automaticPlayback} nativeStage={focused || !focusable && !thumbnail}
      disabled={source.available === false} presentation={source.hidden ? "background" : thumbnail ? "thumbnail" : "full"}
      theaterMode={theaterMode} onToggleTheater={onToggleTheater}
      onPlayback={patch => { if (embedded && patch.paused === false) onFocus(source.id); void playbackAction.run(() => source.onPlayback(patch)); }}
      onResume={() => {
        if (embedded) {
          onFocus(source.id);
          if (source.player?.presentation.kind === "embed") source.player.presentation.element.scrollIntoView({ block: "nearest" });
        }
        // The player owns recovery failures, including a failed replacement.
        void source.onResume().catch(() => {});
      }} />
      : <div className="c3-monitor-wait" role="status">{source.actionFailure ? <PictureFailure error={source.actionFailure} onDismiss={source.clearActionFailure} /> : source.website && !source.pending ? <><Glyph name="globe" size={25} /><span>{t(source.awaitingSource ? "watch.waiting" : "watch.browserFailed")}</span>
        {!source.owned && (source.onAppWatch
          ? <Btn icon="window" title="watch.openPage" cap="watch.openPage" disabled={source.available === false} onClick={source.onAppWatch} />
          : !(source.receiving?.peerAvailable && source.receiving.peerSupported) && (source.originalPageUnavailable
            ? <small>{source.originalPageUnavailable}</small> : source.originalPageAvailable && <small>{t("watch.connectApp")}</small>))}
        {source.receiving && <WatchPeerAction receiving={source.receiving} />}</>
        : <><BrandLoader /><span>{t("watch.waiting")}</span></>}</div>}
    <footer><div className="c3-monitor-source-row" data-tooltip-controls>
      <div className="c3-monitor-source-info">
        <PawnSvg centered color={participantColor(source.userId)} identity={source.userId} avatar={source.avatar} />
        <div className="c3-monitor-source"><Tooltip overflow={{ text: source.title, selector: "strong" }}><strong>{source.title}</strong></Tooltip>
          <small>{source.name}<span aria-hidden="true"> / </span><button type="button" className="c3-source-room" onClick={source.onRoom}>{source.roomName}</button></small>
        </div>
        <div className="c3-monitor-social"><SourceAudience people={source.audience} joined /></div>
      </div>
      <div className="c3-monitor-tile-actions">
        {focusable && !focused && <Tooltip className="c3-monitor-layout-action" kind="hint-screen-focus"
          text={t("screen.focusNamed", { title: source.title })}><Btn icon="screenFocus" quiet size="dense"
          title={{ text: t("screen.focusNamed", { title: source.title }) }} onClick={() => onFocus(source.id)} /></Tooltip>}
        {source.owned ? <div className="c3-monitor-publishing" role="group" aria-label={t("screen.sharingControls", { title: source.title })}>
          {!source.hidden && source.shareControls}
          <span className="c3-monitor-close"><Btn icon="stop" tone="danger" size="dense"
            title="watch.stop" busy={source.pending} disabled={source.pending} onClick={source.onStop} /></span>
        </div> :
        <span className="c3-monitor-close"><Btn icon="x" quiet size="dense"
          title="watch.leave" busy={source.pending} disabled={source.pending}
          onClick={source.onLeave} /></span>}
      </div>
    </div></footer>
  </article>;
}
