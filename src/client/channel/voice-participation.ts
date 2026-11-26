import { debugOperation } from "../lib/debug";
import type { RoomPreferences } from "../lib/room-preferences";
import { audioInputConstraints } from "../media/audio-capture";
import { acquireMediaStream } from "../media/capture-stream";
import { MicrophoneInput } from "../media/microphone-input";
import type { MicrophoneMode } from "../media/voice-gate";
import type { ChannelCommand, ChannelSnapshot } from "./protocol";
import type { ChannelView } from "./types";
import type { VoiceToggleAction } from "./voice-shortcut-binding";

type VoiceInput = RoomPreferences["voiceInput"];
type VoiceTransmission = RoomPreferences["voiceTransmission"];

/** This endpoint's voice in one room: what it asked for, and the publication carrying it. */
interface VoiceIntent {
  publicationId: string | null;
  muted: boolean;
  deafened: boolean;
}

interface MicrophoneRequest {
  controller: AbortController;
  context: AudioContext | null;
  input: MicrophoneInput | null;
  promise?: Promise<MicrophoneInput>;
}

type LocalCapture = Readonly<{ admitted: boolean; roomId: string; kind: "screen" | "voice"; stream: MediaStream; microphone?: MicrophoneInput }>;

/** What voice uses from the session, which keeps the connection, the local publications and the view. */
export interface VoiceSession {
  readonly local: ReadonlyMap<string, LocalCapture>;
  view(): ChannelView;
  /** The last authority snapshot, before local projection. */
  snapshot(): ChannelSnapshot | undefined;
  /** Aborts when the session releases its media. */
  lifetime(): AbortSignal;
  action<T>(key: string, work: () => Promise<T>, reportError?: boolean): Promise<T>;
  request(command: ChannelCommand): Promise<void>;
  send(command: ChannelCommand): void;
  write(command: ChannelCommand): void;
  /** Withdraws this endpoint's publications that no local capture carries, only in this room and kind. */
  unpublishMissing(state: ChannelSnapshot, scope: { roomId: string; kind: "voice" }): void;
  publish(roomId: string, stream: MediaStream, microphone: MicrophoneInput | undefined, publicationId: string): Promise<string>;
  retire(publicationId: string): void;
  /** Republishes the local projection of the current snapshot. */
  refresh(): void;
  levels(roomId: string): Promise<ReadonlyMap<string, number>>;
  saveInput(voiceInput: VoiceInput): void;
  saveTransmission(voiceTransmission: VoiceTransmission): void;
  report(error: string): void;
}

// Keys in the session's pending set. Only this owner starts or reads them.
const inputKey = "voice-input";
const roomKey = (roomId: string) => `voice:${roomId}`;

function microphoneConstraints(settings: VoiceInput): MediaStreamConstraints {
  return { audio: { ...audioInputConstraints(settings.voiceProcessing),
    ...(settings.voiceProcessing && settings.strongerSuppression ? { noiseSuppression: false, channelCount: 1 } : {}),
    ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}) }, video: false };
}

function captureVoiceMicrophone(settings: VoiceInput, signal: AbortSignal): Promise<MediaStream> {
  const requested = microphoneConstraints(settings);
  const complete = debugOperation("capture", "microphone", { requested });
  return acquireMediaStream(() => navigator.mediaDevices.getUserMedia(requested), signal).then(stream => {
    complete("applied", { trackId: stream.getAudioTracks()[0]?.id });
    return stream;
  }).catch(error => {
    complete("failed", {}, error);
    if (error instanceof DOMException && error.name === "NotAllowedError") throw new Error("voice_microphone_permission_denied");
    throw error;
  });
}

/**
 * Room voice for one Browser session. It owns each room's participation and the one
 * microphone whose clones every room publishes, and releases that microphone after its
 * last consumer: a leave, a failed join, removal by the authority or the end of a capture.
 * Screen commentary captures its own microphone. The session keeps the publications,
 * personal playback and the input preference, which this owner changes for voice.
 */
export class VoiceParticipation {
  private readonly rooms = new Map<string, VoiceIntent>();
  private readonly lastOn: Record<VoiceToggleAction, Set<string>> = { microphone: new Set(), listening: new Set() };
  private microphone: MicrophoneInput | null = null;
  private microphoneRequest: MicrophoneRequest | null = null;
  private talkPressed = false;

  constructor(private readonly session: VoiceSession) {}

  private get preference(): VoiceInput { return this.session.view().voiceInput; }
  private get transmission(): VoiceTransmission { return this.session.view().voiceTransmission; }

  /** In this room, or in any room when none is given. */
  joined(roomId?: string): boolean { return roomId === undefined ? this.rooms.size > 0 : this.rooms.has(roomId); }

  /** A voice operation is pending in this room or, when none is given, anywhere, including an input change. */
  busy = (roomId?: string): boolean => {
    const { pending } = this.session.view();
    return roomId === undefined ? [...pending].some(key => key === inputKey || key.startsWith("voice:")) : pending.has(roomKey(roomId));
  };

  join = (roomId: string, listenOnly = false, reportError = true, providedStream?: MediaStream): Promise<void> => this.session.action(roomKey(roomId), async () => {
    if (this.rooms.has(roomId)) return;
    const intent: VoiceIntent = { publicationId: null, muted: listenOnly, deafened: false };
    this.rooms.set(roomId, intent);
    let supplied = listenOnly ? undefined : providedStream;
    try {
      const microphone = !listenOnly && !supplied ? await this.getMicrophone() : undefined;
      if (this.rooms.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
      await this.session.request({ type: "voice", roomId, joined: true, muted: intent.muted, deafened: intent.deafened });
      if (this.rooms.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
      if (!intent.muted && (supplied || microphone)) {
        const capture = supplied ?? microphone!.stream.clone();
        supplied = undefined;
        const id = intent.publicationId = crypto.randomUUID();
        await this.session.publish(roomId, capture, microphone, id);
        if (this.rooms.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
        capture.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
        this.refresh();
      } else {
        supplied?.getTracks().forEach(track => track.stop());
      }
    } catch (error) {
      supplied?.getTracks().forEach(track => track.stop());
      const left = this.rooms.get(roomId) !== intent;
      if (!left) this.forgetRoom(roomId);
      if (intent.publicationId) this.session.retire(intent.publicationId);
      this.release();
      if (left) throw new DOMException("Voice left", "AbortError");
      await this.session.request({ type: "voice", roomId, joined: false, muted: true, deafened: false }).catch(() => {});
      throw error;
    }
  }, reportError);

  leave = (roomId: string): Promise<void> => {
    const id = this.rooms.get(roomId)?.publicationId;
    this.forgetRoom(roomId);
    if (id) this.session.retire(id);
    this.refresh();
    return this.sync(roomId);
  };

  microphonePending = (roomId?: string): boolean => {
    if (roomId === undefined) return [...this.rooms.keys()].some(id => this.microphonePending(id));
    const intent = this.rooms.get(roomId);
    return !!intent && !intent.muted && this.busy(roomId);
  };

  private forgetRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.lastOn.microphone.delete(roomId);
    this.lastOn.listening.delete(roomId);
  }

  toggleShortcut = (action: VoiceToggleAction): boolean => {
    const { state, sessionId } = this.session.view();
    const members = state?.voice.filter(member => member.sessionId === sessionId) ?? [];
    const on = new Set(members.filter(member => action === "microphone" ? !member.muted : !member.deafened)
      .map(member => member.roomId));
    // A joining room can already be waiting for permission before it appears in the snapshot.
    const closing = [...this.rooms.keys()].filter(roomId => on.has(roomId) || action === "microphone" && this.microphonePending(roomId));
    const set = action === "microphone" ? this.setMuted : this.setDeafened;
    if (closing.length) {
      for (const roomId of closing) {
        // Cancel an unjoined room's request before it can announce participation.
        const operation = members.some(member => member.roomId === roomId) ? set(roomId, true) : this.leave(roomId);
        void operation.catch(() => {});
      }
      // The writes above refresh synchronously. Remember the whole press, ahead of any replies.
      if (on.size) this.lastOn[action] = on;
      return true;
    }
    const joined = [...this.rooms.keys()].filter(roomId => members.some(member => member.roomId === roomId));
    const remembered = joined.filter(roomId => this.lastOn[action].has(roomId));
    const targets = (remembered.length ? remembered : joined.slice(-1))
      .filter(roomId => action === "listening" || this.canUnmute(roomId));
    for (const roomId of targets) void set(roomId, false).catch(() => {});
    return targets.length > 0;
  };

  canUnmute = (roomId: string): boolean => {
    const intent = this.rooms.get(roomId);
    const view = this.session.view();
    const room = view.state?.channel.rooms.find(room => room.id === roomId);
    if (!intent || !room?.authorized) return false;
    const stream = intent.publicationId ? this.session.local.get(intent.publicationId)?.stream : undefined;
    return !!stream?.getAudioTracks().some(track => track.readyState === "live")
      || view.connection === "connected" && room.available && !this.busy(roomId);
  };

  activity = async (roomId: string, localOnly = false): Promise<ReadonlyMap<string, number>> => {
    let view = this.session.view();
    const sessionId = view.sessionId;
    const intent = this.rooms.get(roomId);
    if (!sessionId || !intent || !view.state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return new Map();
    const levels = new Map(localOnly ? [] : await this.session.levels(roomId));
    view = this.session.view();
    if (view.sessionId !== sessionId || this.rooms.get(roomId) !== intent
      || !view.state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return new Map();
    for (const id of levels.keys()) if (id === sessionId || intent.deafened
      || !view.state.voice.some(voice => voice.roomId === roomId && voice.sessionId === id && !voice.muted)) levels.delete(id);
    const capture = intent.publicationId ? this.session.local.get(intent.publicationId) : undefined;
    if (!intent.muted && capture?.roomId === roomId && capture.kind === "voice" && capture.microphone?.transmitting
      && capture.stream.getAudioTracks().some(track => track.readyState === "live" && track.enabled)) {
      levels.set(sessionId, capture.microphone.level());
    }
    return levels;
  };

  setMuted = (roomId: string, muted: boolean): Promise<void> => {
    const intent = this.rooms.get(roomId);
    if (!intent) return Promise.resolve();
    if (!muted && !this.canUnmute(roomId)) return Promise.reject(new Error("capture_unavailable"));
    intent.muted = muted;
    const stream = intent.publicationId ? this.session.local.get(intent.publicationId)?.stream : undefined;
    stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.refresh();
    if (!muted && !stream) return this.session.action(roomKey(roomId), async () => {
      try {
        const microphone = await this.getMicrophone();
        if (this.rooms.get(roomId) !== intent || intent.muted) return;
        const capture = microphone.stream.clone();
        const id = intent.publicationId = crypto.randomUUID();
        await this.session.publish(roomId, capture, microphone, id);
        if (this.rooms.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
        capture.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
        this.refresh();
        await this.session.request({ type: "voice", roomId, joined: true, muted: intent.muted, deafened: intent.deafened });
      } catch (error) {
        const left = this.rooms.get(roomId) !== intent;
        if (intent.publicationId) this.session.retire(intent.publicationId);
        if (!left) { intent.publicationId = null; intent.muted = true; }
        this.refresh();
        if (left) throw new DOMException("Voice left", "AbortError");
        throw error;
      }
    });
    return this.sync(roomId);
  };

  setDeafened = (roomId: string, deafened: boolean): Promise<void> => {
    const intent = this.rooms.get(roomId);
    if (!intent) return Promise.resolve();
    intent.deafened = deafened;
    this.refresh();
    return this.sync(roomId);
  };

  setInputVolume = (volume: number): void => {
    this.microphone?.volume(volume);
    this.microphoneRequest?.input?.volume(volume);
    this.session.saveInput({ ...this.preference, volume });
  };

  /** A capture in progress applies the mode before it publishes, so this waits for it. */
  setMicrophoneMode = (mode: MicrophoneMode): Promise<void> => this.session.action(inputKey, async () => {
    const signal = this.session.lifetime();
    // The pending capture reports its own failure.
    await this.microphoneRequest?.promise?.catch(() => {});
    signal.throwIfAborted();
    await this.microphone?.gate(mode);
    this.session.saveTransmission({ ...this.transmission, mode });
  });

  setActivationThreshold = (activationThreshold: number): void => {
    this.microphone?.threshold(activationThreshold);
    this.microphoneRequest?.input?.threshold(activationThreshold);
    this.session.saveTransmission({ ...this.transmission, activationThreshold });
  };

  talk = (pressed: boolean): void => {
    this.talkPressed = pressed;
    this.microphone?.press(pressed);
  };

  inputLevel = (): number | undefined => this.microphone?.level();

  configureInput = (settings: Partial<Pick<VoiceInput, "deviceId" | "voiceProcessing" | "strongerSuppression">>): Promise<void> => this.session.action(inputKey, async () => {
    const signal = this.session.lifetime();
    if (this.microphoneRequest) await this.microphoneRequest.promise;
    signal.throwIfAborted();
    const previous = this.preference;
    const voiceInput = { ...previous, ...settings };
    const enhanced = Boolean(voiceInput.voiceProcessing && voiceInput.strongerSuppression);
    const input = this.microphone;
    if (input && (voiceInput.deviceId !== previous.deviceId || voiceInput.voiceProcessing !== previous.voiceProcessing
      || enhanced !== Boolean(previous.voiceProcessing && previous.strongerSuppression))) {
      let captured: MediaStream | undefined = await captureVoiceMicrophone(voiceInput, input.signal);
      try {
        signal.throwIfAborted();
        if (this.microphone !== input) throw new DOMException("Microphone capture cancelled", "AbortError");
        await input.configure(captured, enhanced);
        captured = undefined;
      } finally { captured?.getTracks().forEach(track => track.stop()); }
    }
    this.session.saveInput({ ...voiceInput, volume: this.preference.volume });
  });

  /** Follows an authority snapshot: a room that no longer lists this endpoint ends its participation unless a request for it is pending. */
  update(state: ChannelSnapshot): void {
    const { sessionId } = this.session.view();
    for (const [roomId, intent] of this.rooms) {
      const member = state.voice.find(member => member.sessionId === sessionId && member.roomId === roomId);
      const { publicationId } = intent;
      const stream = publicationId ? this.session.local.get(publicationId)?.stream : undefined;
      if (member && stream) stream.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
      if (!member && !this.busy(roomId)) {
        this.forgetRoom(roomId);
        if (publicationId) this.session.retire(publicationId);
      }
    }
    this.release();
  }

  /** A room's writer is back: a listen-only participation drops stale publications and re-sends its state. */
  resumed(state: ChannelSnapshot, roomId: string): void {
    if (this.rooms.get(roomId)?.publicationId !== null || this.busy(roomId)) return;
    this.session.unpublishMissing(state, { roomId, kind: "voice" });
    this.reconcile(state, roomId);
  }

  /** Re-sends voice state wherever the authority's record of this endpoint differs from local intent. */
  reconcile(state: ChannelSnapshot, roomId?: string): void {
    const { sessionId } = this.session.view();
    for (const member of state.voice) {
      if (member.sessionId !== sessionId || (roomId !== undefined && member.roomId !== roomId)) continue;
      const intent = this.rooms.get(member.roomId);
      if (!intent || member.muted !== intent.muted || member.deafened !== intent.deafened)
        this.session.write({ type: "voice", roomId: member.roomId, joined: !!intent, muted: intent?.muted ?? true, deafened: intent?.deafened ?? false });
    }
  }

  /** This endpoint's own voice as local intent and live capture show it, ahead of the authority. */
  project(members: ChannelSnapshot["voice"]): ChannelSnapshot["voice"] {
    const { sessionId } = this.session.view();
    const microphone = new Set<string>(), listening = new Set<string>();
    const projected = members.flatMap(member => {
      if (member.sessionId !== sessionId) return [member];
      const intent = this.rooms.get(member.roomId);
      if (!intent) return [];
      const capture = intent.publicationId ? this.session.local.get(intent.publicationId) : undefined;
      const active = !intent.muted && capture?.admitted
        && capture.stream.getAudioTracks().some(track => track.readyState === "live" && track.enabled);
      if (active) microphone.add(member.roomId);
      if (!intent.deafened) listening.add(member.roomId);
      return [{ ...member, muted: !active, deafened: intent.deafened }];
    });
    if (microphone.size) this.lastOn.microphone = microphone;
    if (listening.size) this.lastOn.listening = listening;
    return projected;
  }

  /** The session retired a publication. A room that published it stays joined, muted. */
  captureRetired(id: string): void {
    for (const intent of this.rooms.values()) {
      if (intent.publicationId === id) { intent.publicationId = null; intent.muted = true; }
    }
    this.release();
  }

  /** A voice track ended at its source: retire its publication and stay in the room, muted. */
  captureEnded(id: string, stream: MediaStream): void {
    const capture = this.session.local.get(id);
    if (capture?.stream !== stream) return;
    const roomId = capture.roomId;
    const { state, sessionId } = this.session.view();
    const member = state?.voice.find(member => member.sessionId === sessionId && member.roomId === roomId);
    this.session.retire(id);
    this.refresh();
    this.session.send({ type: "unpublish", publicationId: id });
    if (member) this.session.send({ type: "voice", roomId, joined: true, muted: true, deafened: member.deafened });
  }

  close(): void {
    this.talkPressed = false;
    this.rooms.clear();
    this.lastOn.microphone.clear();
    this.lastOn.listening.clear();
    this.release();
  }

  private sync(roomId: string): Promise<void> {
    const intent = this.rooms.get(roomId);
    const { sessionId, connection } = this.session.view();
    // Listening can change while an unmute is still waiting for capture or publication.
    const member = this.session.snapshot()?.voice.find(value => value.roomId === roomId && value.sessionId === sessionId);
    const muted = !intent || intent.muted || (!this.session.local.get(intent.publicationId ?? "")?.admitted && (member?.muted ?? true));
    const command = { type: "voice" as const, roomId, joined: !!intent, muted, deafened: intent?.deafened ?? false };
    if (connection !== "connected") return Promise.resolve();
    if (this.busy(roomId)) {
      // Local intent can stop a source while an earlier authority reply is pending.
      this.session.send(command);
      return Promise.resolve();
    }
    return this.session.action(roomKey(roomId), async () => {
      try { await this.session.request(command); }
      catch (error) { if (!(error instanceof Error) || error.message !== "disconnected") throw error; }
    });
  }

  private refresh(): void {
    this.session.refresh();
    this.release();
  }

  private release(): void {
    if ([...this.rooms.values()].some(intent => !intent.muted)) return;
    const request = this.microphoneRequest;
    this.microphoneRequest = null;
    request?.controller.abort();
    request?.input?.close();
    void request?.context?.close().catch(() => {});
    if (request) request.context = null;
    if ([...this.rooms.values()].some(intent => intent.publicationId)) return;
    this.microphone?.close();
    this.microphone = null;
  }

  private async getMicrophone(): Promise<MicrophoneInput> {
    if (this.microphone?.stream.active) return this.microphone;
    if (this.microphoneRequest) return this.microphoneRequest.promise!;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("microphone_unavailable");
    const signal = this.session.lifetime();
    // Resume during the gesture, before device permission consumes activation.
    const context = new AudioContext();
    const resumed = context.resume().then(() => true, () => false);
    const request: MicrophoneRequest = { controller: new AbortController(), context, input: null };
    const requestSignal = AbortSignal.any([signal, request.controller.signal]);
    request.promise = (async () => {
      let stream: MediaStream | undefined, input: MicrophoneInput | undefined;
      try {
        stream = await captureVoiceMicrophone(this.preference, requestSignal);
        requestSignal.throwIfAborted();
        if (stream.getAudioTracks()[0]?.readyState !== "live") throw new Error("microphone_unavailable");
        const captured = input = new MicrophoneInput(stream, context, this.preference.volume, () => {
          for (const [id, capture] of [...this.session.local]) if (capture.microphone === captured) this.captureEnded(id, capture.stream);
          captured.close();
          if (this.microphone === captured) this.microphone = null;
        });
        request.input = captured;
        request.context = null;
        captured.onProcessingError = error => { captured.close(); this.microphone = null; for (const [id, capture] of [...this.session.local]) if (capture.microphone === captured) this.captureEnded(id, capture.stream); this.session.report(error); };
        await captured.configure(stream, Boolean(this.preference.voiceProcessing && this.preference.strongerSuppression));
        // Push to talk and voice activation must hold before the first packet; a gate that fails stops the capture.
        captured.threshold(this.transmission.activationThreshold);
        await captured.gate(this.transmission.mode);
        const started = await resumed;
        requestSignal.throwIfAborted();
        if (!started || !captured.stream.active) throw new Error("microphone_unavailable");
        captured.volume(this.preference.volume);
        if (this.transmission.mode === "push") captured.press(this.talkPressed);
        this.microphone = captured;
        request.input = null;
        return captured;
      } catch (error) {
        if (input) input.close();
        else stream?.getTracks().forEach(track => track.stop());
        void request.context?.close().catch(() => {});
        request.context = null;
        throw error;
      }
    })().finally(() => { if (this.microphoneRequest === request) this.microphoneRequest = null; });
    this.microphoneRequest = request;
    return request.promise;
  }
}
