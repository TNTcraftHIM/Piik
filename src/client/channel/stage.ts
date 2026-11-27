import type { AppPage, ChannelApp } from "./app-link";
import type { EncodingExecution } from "../native/wire";
import type { CommentaryInput } from "../media/host-audio";
import type { QualityProfile } from "../media/quality";
import type { BrowserVideoCodecMode, BrowserVideoCodecPreference } from "../webrtc/video-codec";
import type { NativeCaptureSelection } from "../native/capture-selection";
import type { SourceMicrophoneConfiguration } from "./types";
import type { WatchMedia } from "./watch-media";
import type { WatchPlayer } from "./watch-playback";
import type { WatchMediaSources, observeWatchSources } from "./watch-page-media";
import { debugEvent } from "../lib/debug";
import type { ChannelSnapshot } from "./protocol";
import { sameWatchByteSource } from "./watch-bytes";

export interface SourceSelection {
  readonly replaceWatchId?: string;
  replaceScreenId?: string;
  controller: AbortController;
  committing: boolean;
  watchCandidate?: WatchPlayer;
  browserCaptureGranted?: boolean;
  releaseBrowserCandidate?: () => void;
  readonly borrowed: boolean;
  // Scopes Native media preparation and cancellation on a borrowed page until confirmation.
  pendingCandidateId?: string;
  readonly page?: AppPage;
  embed?: WatchMedia & { readonly sourceURL: string };
  watchSources?: { candidateId: string } & WatchMediaSources;
  discovery?: ReturnType<typeof observeWatchSources>;
}

interface ActiveSourceSelection extends SourceSelection {
  page?: AppPage;
  releasePage?: () => void;
}

export interface ScreenShare {
  id: string;
  paused?: boolean;
  profile: QualityProfile;
  codecMode: BrowserVideoCodecMode;
  encodingExecution: EncodingExecution;
  codec?: BrowserVideoCodecPreference;
  volume: { level: number; muted: boolean };
  microphone: CommentaryInput;
  requestedMicrophone?: { settings: SourceMicrophoneConfiguration; started?: Promise<void> };
  microphoneChange?: Promise<void>;
  audioChange?: Promise<void>;
  requestedProfile?: QualityProfile;
  qualityChange?: Promise<void>;
  native?: NativeCaptureSelection;
}

/** The local stage in one room owns selection, screen identity and watch-player resources. */
export class Stage {
  private selection?: ActiveSourceSelection;
  private share?: ScreenShare;
  private readonly players = new Map<string, WatchPlayer>();
  private readonly preparations = new Map<string, WatchPlayer>();

  constructor(readonly roomId: string, private readonly screenPresent: (id: string) => boolean,
    private readonly changed: () => void) {}

  get sourceSelection(): SourceSelection | undefined { return this.selection; }
  get screen(): ScreenShare | undefined { return this.share; }
  get empty(): boolean { return !this.selection && !this.share && !this.players.size && !this.preparations.size; }
  watches(): IterableIterator<[string, WatchPlayer]> { return this.players.entries(); }
  candidates(): IterableIterator<[string, WatchPlayer]> { return this.preparations.entries(); }
  watch(id: string): WatchPlayer | undefined { return this.players.get(id); }
  candidate(id: string): WatchPlayer | undefined { return this.preparations.get(id); }

  selectSource(page?: AppPage): SourceSelection {
    if (this.selection) this.finishSelection(this.selection);
    const replaceWatchId = [...this.players].find(([, player]) => player.owner && player.mode)?.[0];
    const selection: ActiveSourceSelection = { replaceWatchId, replaceScreenId: this.share?.id,
      controller: new AbortController(), committing: false, borrowed: !!page };
    if (page) this.usePage(selection, page, page.hold());
    return this.selection = selection;
  }

  async openPage(selection: SourceSelection, app: ChannelApp, url: string): Promise<void> {
    const page = await app.preparePage(url, this.changed, selection.controller.signal);
    const current = this.selection;
    if (current !== selection) {
      page.close();
      throw new DOMException("Cancelled", "AbortError");
    }
    this.usePage(current, page, () => page.close());
    page.enableSharePicker();
  }

  private usePage(selection: ActiveSourceSelection, page: AppPage, release: () => void): void {
    selection.page = page;
    selection.releasePage = release;
    const unlisten = page.listen(event => {
      if (event === "closed" && this.selection === selection) {
        this.finishSelection(selection);
        this.changed();
      }
    });
    selection.controller.signal.addEventListener("abort", unlisten, { once: true });
  }

  updateAvailability(available: boolean): void {
    if (!available && this.selection) this.finishSelection(this.selection);
  }

  selectScreen(share: ScreenShare): { share: ScreenShare; selection: SourceSelection; current(): boolean } {
    const selection = this.selectSource();
    this.share = share;
    return { share, selection, current: () => this.share === share && this.selection === selection };
  }

  finishSelection(selection: SourceSelection): void {
    const current = this.selection;
    if (current !== selection) return;
    this.selection = undefined;
    const candidateId = selection.pendingCandidateId;
    delete selection.pendingCandidateId;
    if (candidateId) void selection.page?.stopMedia(candidateId).catch(() => {});
    selection.controller.abort();
    selection.releaseBrowserCandidate?.();
    current.releasePage?.();
    if (!selection.committing) {
      if (selection.watchCandidate) selection.watchCandidate.close();
      else selection.embed?.close();
    }
    if (this.share) this.forgetInactiveScreen(this.share.id);
  }

  forgetInactiveScreen(id: string): void {
    if (this.share?.id === id && !this.selection && !this.screenPresent(id)) this.share = undefined;
  }

  screenRemoved(id: string): void {
    if (this.share?.id === id) this.share = undefined;
  }

  stopScreen(id: string): void {
    if (this.share?.id !== id) return;
    const selection = this.selection;
    if (selection && (!selection.committing || selection.releaseBrowserCandidate)) this.finishSelection(selection);
    this.share = undefined;
  }

  prepareWatch(id: string, player: WatchPlayer): void {
    const previous = this.preparations.get(id);
    this.preparations.set(id, player);
    if (previous !== player) previous?.close();
  }

  /** An embed may remain a preparation until its newly active picture is presented. */
  finishWatchPreparation(id: string, player: WatchPlayer): void {
    if (this.preparations.get(id) === player) this.preparations.delete(id);
  }

  useWatch(id: string, player: WatchPlayer): void {
    const previous = this.players.get(id);
    this.players.set(id, player);
    if (previous !== player) previous?.close();
  }

  confirmWatch(id: string, player: WatchPlayer): void {
    if (this.preparations.get(id) !== player) throw new DOMException("Cancelled", "AbortError");
    this.preparations.delete(id);
    player.inheritListening(this.players.get(id));
    this.useWatch(id, player);
  }

  retireCandidate(id: string): WatchPlayer | undefined {
    const candidate = this.preparations.get(id);
    if (!candidate) return;
    this.preparations.delete(id);
    candidate.close();
    this.changed();
    return candidate;
  }

  retireWatch(id: string, reason?: string): void {
    const player = this.players.get(id);
    if (player?.owner && reason) {
      const pageId = player.media.page?.id;
      debugEvent("channel", "watch-owner-retired", { activityId: id, reason, ...(pageId && { pageId }) });
    }
    this.players.delete(id);
    player?.close();
  }

  reconcileWatches(state: ChannelSnapshot, previous: ChannelSnapshot | undefined,
    restoring: boolean, stopOwner: (id: string) => void): void {
    const room = state.channel.rooms.find(room => room.id === this.roomId);
    const available = room?.authorized && room.available;
    for (const [id] of this.preparations) {
      if (!available || !state.watchActivities.some(activity => activity.id === id)) this.retireCandidate(id);
    }
    for (const [id, player] of this.players) {
      const activity = state.watchActivities.find(value => value.id === id);
      const previousActivity = previous?.watchActivities.find(value => value.id === id);
      if (!room?.authorized || (!activity && (!available || previousActivity || this.selection?.watchCandidate !== player))) {
        this.retireWatch(id, "activity-removed");
      } else if (!player.owner && (!restoring || player.signal.aborted) && !state.watchSubscriptions.some(value => value.id === id)
        && previous?.watchSubscriptions.some(value => value.id === id)) this.retireWatch(id);
      else if (activity) {
        const retained = player.media.retainedByteSource;
        if (player.owner && retained && !state.sessions.some(session => session.id === retained.sessionId)) {
          stopOwner(id);
          continue;
        }
        const previousSource = previousActivity?.byteSource;
        const nextSource = activity.byteSource;
        if (player.mode === "peer" && previousSource && !sameWatchByteSource(previousSource, nextSource)) {
          // Participation remains while this byte source and its reader retire.
          player.error = nextSource ? "watch_source_changed" : "watch_source_unavailable";
          player.close();
        } else player.update(activity.playback);
      }
    }
  }

  close(): void {
    if (this.selection) this.finishSelection(this.selection);
    this.share = undefined;
    for (const id of this.preparations.keys()) this.retireCandidate(id);
    for (const id of this.players.keys()) this.retireWatch(id, "session-released");
  }
}
