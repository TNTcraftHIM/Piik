import { useEffect, useState, useSyncExternalStore } from "react";
import { Btn } from "../components/living/primitives";
import { MicrophoneSettings } from "../components/living/MicrophoneSettings";
import { AudioBitrateControl } from "../components/living/QualityPresets";
import { MAX_AUDIO_SEND_BITRATE } from "../media/quality";
import { AudioVolumeControl } from "../components/living/AudioVolumeControl";
import { AudioVolumeMenu } from "../components/living/AudioVolumeMenu";
import { PawnSvg } from "../components/living/Pawn";
import { Tooltip } from "../components/living/Tooltip";
import { participantColor } from "../components/living/participant-color";
import { labelParticipantNames } from "../lib/viewer-presence";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import type { RoomVoiceSession } from "./session";
import { MicrophoneLevel } from "./MicrophoneLevel";
import { describeVoiceParticipant } from "./participant-presentation";
import "./room-voice.css";

export type RoomVoiceView = Pick<RoomVoiceSession, "subscribe" | "getSnapshot" | "resumeAudio" | "command" |
  "startMicrophone" | "stopMicrophone" | "muteVoice" | "deafen" | "configureInput" | "setVolume" | "setListeningVolume" | "setPeerVolume" | "activity" | "microphones">;
interface Props { session: RoomVoiceView }

function useVoiceLevels(session: RoomVoiceView, enabled: boolean, localOnly = false): ReadonlyMap<string, number> {
  const [levels, setLevels] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!enabled) { setLevels(new Map()); return; }
    let current = true, timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      try { const levels = await session.activity(localOnly); if (current) setLevels(levels); }
      catch { if (current) setLevels(new Map()); }
      finally { if (current) timer = setTimeout(() => void sample(), 150); }
    };
    void sample();
    return () => { current = false; clearTimeout(timer); };
  }, [session, enabled, localOnly]);
  return levels;
}

export function RoomVoiceControls({ session }: Props) {
  const { t, vis } = useCopy();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const levels = useVoiceLevels(session, state.microphone, true);
  const microphoneUnavailable = !state.microphone && !state.capturePending && !navigator.mediaDevices?.getUserMedia;
  const joined = Boolean(me?.joined);
  const host = state.role === "host";
  const voiceClosed = !host && state.room?.enabled === false;
  const canClose = host && Boolean(state.room?.enabled);
  const actionTitle = host ? canClose ? "voice.close" : "voice.open" : joined ? "voice.leave" : "voice.join";
  const actionHint = host ? canClose ? "hint-voice-close" : "hint-voice-open"
    : joined ? "hint-voice-leave" : voiceClosed ? "hint-voice-closed" : "hint-voice-join";
  const actionExplanation = host ? canClose ? "voice.closeHint" : "voice.openHint" : voiceClosed ? "voice.closedHint" : undefined;
  return <>
    <div className="lr-voice-toolbar lr-media-controls" role="group" aria-label={t("interaction.voice")}>
      {joined && <div className="lr-voice-quick-controls">
        <AudioVolumeMenu volume={state.input.volume} onVolume={volume => session.setVolume(volume)}
          label="host.microphone.volume" icon="microphone" disabled={microphoneUnavailable || state.capturePending}>
        <Btn icon={state.microphone ? "microphone" : "microphoneOff"} title="host.device.microphone"
          size="compact" draw="voice-microphone" hint={microphoneUnavailable ? host ? "hint-voice-host-microphone-unavailable" : "hint-voice-microphone-unavailable"
            : state.capturePending ? "hint-close" : undefined}
          hintText={microphoneUnavailable ? "voice.error.microphoneUnavailable" : "voice.captureCancel"}
          pressed={state.microphone} busy={state.capturePending} disabled={!state.connected || microphoneUnavailable}
          iconOverlay={state.microphone && !state.capturePending && <MicrophoneLevel level={levels.get(state.peerId) ?? 0} />}
          onClick={() => {
            session.resumeAudio();
            if (state.microphone || state.capturePending) session.stopMicrophone(); else void session.startMicrophone();
          }} />
        </AudioVolumeMenu>
        <AudioVolumeMenu volume={state.listeningVolume} onVolume={volume => session.setListeningVolume(volume)}
          label="voice.listeningVolume" icon="headphones">
        <Btn icon={state.deafened ? "headphonesOff" : "headphones"} title="voice.listening"
          size="compact" draw="voice-listening"
          pressed={!state.deafened} onClick={() => session.deafen(!state.deafened)} />
        </AudioVolumeMenu>
      </div>}
      {canClose && !joined && <Btn icon="headphones" cap="voice.join" title="voice.join" size="compact" disabled={!state.connected}
        onClick={() => { session.resumeAudio(); session.command({ action: "join" }); }} />}
      <Btn icon={canClose ? "stop" : !joined ? "headphones" : "door"}
        title={actionTitle} cap={actionTitle} tone={canClose ? "danger" : undefined} size="compact" draw="voice-membership"
        hint={actionHint} hintText={actionExplanation}
        disabled={!state.connected || !state.room || !joined && !host && !state.room.enabled}
        onClick={() => { if (!joined) session.resumeAudio(); session.command({ action: joined || canClose ? "leave" : "join" }); }} />
    </div>
    {state.autoplayBlocked && <Btn icon="play" title="voice.play" cap="voice.play" size="compact" hint="hint-local-play" onClick={() => session.resumeAudio()} />}
    {state.error && <p className="lr-voice-control-error" role="alert"><Glyph name="alert" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t(`voice.error.${state.error}`)}</span></p>}
  </>;
}

// Capture and transport belong to the session above this movable window.
export function RoomVoiceSettings({ session }: Props) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t } = useCopy();
  return <div className="lr-floating-scroll lr-interaction-settings lr-voice-settings">
    <MicrophoneSettings host={state.role === "host"} enabled={state.microphone} disabled={state.capturePending}
      loadDevices={session.microphones} deviceId={state.input.deviceId} onDevice={deviceId => void session.configureInput({ deviceId })}
      volume={state.input.volume} onVolume={value => session.setVolume(value)}
      voiceProcessing={state.input.voiceProcessing} onVoiceProcessing={voiceProcessing => void session.configureInput({ voiceProcessing })} />
    <div className="lr-door-group lr-audio-settings" role="group" aria-label={t("voice.listening")}>
      <AudioVolumeControl volume={state.listeningVolume} onVolume={value => session.setListeningVolume(value)}
        label="voice.listeningVolume" icon="headphones" hint="hint-volume" hintText="voice.listeningVolumeHint" />
    </div>
    {state.role === "host" && state.room?.bitrate !== undefined && <AudioBitrateControl purpose="voice"
      value={state.room.bitrate} max={MAX_AUDIO_SEND_BITRATE} disabled={!state.connected}
      onChange={bitrate => session.command({ action: "bitrate", bitrate })} />}
  </div>;
}

export function RoomVoicePanel({ session, names, onSelectParticipant }: Props & {
  names?: ReadonlyMap<string, string>;
  onSelectParticipant?: (peerId: string, trigger: HTMLButtonElement) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const levels = useVoiceLevels(session, Boolean(me?.joined));
  const members = labelParticipantNames((state.room?.members ?? []).filter(member => member.connected).map(member => ({
    ...member, displayName: names?.get(member.peerId) ?? t("voice.participant"),
  })));
  return <div className="lr-room-voice">
    <div className="lr-voice-panel-heading">
      <span>{vis && <Glyph name="users" size={16} />}
        <span className={vis ? "visually-hidden" : undefined}>{t("voice.participants")}</span></span>
    </div>
    {!vis && state.role === "viewer" && !state.room?.enabled && <p className="lr-voice-hint">{t("voice.closedHint")}</p>}
    {state.room?.unavailable.length ? <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.unavailable")}</span></p> : null}
    {!state.connected && <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.reconnecting")}</span></p>}
    <div className="lr-voice-members">
      {members.map(member => {
        const status = describeVoiceParticipant(member);
        const speaking = !!member.publicationId && (levels.get(member.peerId) ?? 0) > .01;
        return <article className="lr-voice-member" key={member.peerId} data-room-peer={member.peerId}>
          <div className="lr-voice-identity">
            {onSelectParticipant ? <Tooltip kind="hint-reaction-picker"
              text={vis ? undefined : t("interaction.withPerson", { name: member.label })}>
              <button type="button" className="lr-voice-avatar"
              aria-label={t("interaction.withPerson", { name: member.label })}
              onClick={event => onSelectParticipant(member.peerId, event.currentTarget)}>
              <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />
            </button></Tooltip> : <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />}
            <Tooltip className="lr-voice-name-tip" overflow={{ text: member.label, selector: ".lr-voice-name" }}><b><span className="lr-voice-name">{member.label}</span>{member.peerId === state.peerId && <span className={vis ? "visually-hidden" : undefined}>{`, ${t("voice.self")}`}</span>}</b></Tooltip>
            <Tooltip toggleOnClick kind={member.joined ? member.publicationId ? "hint-voice-microphone-on" : "hint-voice-microphone-off" : "hint-voice-join"}
              text={vis ? undefined : t(status.label)}>
              <button type="button" className="lr-voice-member-mic" data-speaking={speaking || undefined}
                aria-label={speaking ? `${t(status.label)} · ${t("voice.speaking")}` : t(status.label)}>
                <Glyph name={status.icon} size={20} />
                {member.publicationId && <MicrophoneLevel level={levels.get(member.peerId) ?? 0} />}
              </button>
            </Tooltip>
            {status.appearance?.deafened && <Tooltip toggleOnClick kind="hint-voice-deafen" text={vis ? undefined : t("voice.listeningPaused")}>
              <button type="button" className="lr-voice-member-mic" aria-label={t("voice.listeningPaused")}><Glyph name="headphonesOff" size={18} /></button>
            </Tooltip>}
          </div>
          {member.peerId !== state.peerId && me?.joined && member.joined && <div className="lr-voice-member-controls">
            <span className="lr-voice-person-volume" aria-hidden="true">{Math.round((state.peerVolumes.get(member.peerId) ?? 1) * 100)}%</span>
            <AudioVolumeMenu volume={state.peerVolumes.get(member.peerId) ?? 1} onVolume={volume => session.setPeerVolume(member.peerId, volume)}
              label="voice.personVolume" icon="speaker" heading={member.label}>
            <Btn icon={state.muted.has(member.peerId) ? "speakerOff" : "speaker"} size="dense"
              title="voice.listenPerson" draw="voice-person-listening"
              pressed={!state.muted.has(member.peerId)} onClick={() => session.muteVoice(member.peerId)} />
            </AudioVolumeMenu>
          </div>}
        </article>;
      })}
    </div>
    {vis && <span className="visually-hidden">{t("interaction.voice")}</span>}
  </div>;
}
