import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Btn } from "../components/living/primitives";
import { MicrophoneSettings } from "../components/living/MicrophoneSettings";
import { AudioVolumeControl } from "../components/living/AudioVolumeControl";
import { PawnSvg } from "../components/living/Pawn";
import { Tooltip } from "../components/living/Tooltip";
import { participantColor } from "../components/living/participant-color";
import { labelParticipantNames } from "../lib/viewer-presence";
import { useCopy, type CopyKey } from "../ui/copy";
import { Glyph, type GlyphName } from "../ui/icons";
import type { RoomVoiceSession, RoomVoiceSnapshot } from "./session";
import "./room-voice.css";

export type RoomVoiceView = Pick<RoomVoiceSession, "subscribe" | "getSnapshot" | "resumeAudio" | "command" |
  "startMicrophone" | "stopMicrophone" | "muteVoice" | "deafen" | "configureInput" | "setVolume" | "setListeningVolume" | "activity" | "microphones">;
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
  const levels = useVoiceLevels(session, state.microphone, true), meterId = useId();
  const level = Math.min(1, (levels.get(state.peerId) ?? 0) * 5);
  const microphoneTitle = state.capturePending ? "voice.captureCancel" : state.microphone ? "voice.microphoneOff" : "voice.microphoneOn";
  const microphoneUnavailable = !state.microphone && !state.capturePending && !navigator.mediaDevices?.getUserMedia;
  const joined = Boolean(me?.joined);
  const host = state.role === "host";
  const actionTitle = host ? joined ? "voice.close" : "voice.open" : joined ? "voice.leave" : "voice.join";
  const actionHint = host ? joined ? "hint-voice-close" : "hint-voice-open" : joined ? "hint-voice-leave" : "hint-voice-join";
  const actionExplanation = host ? joined ? "voice.closeHint" : "voice.openHint" : !state.room?.enabled ? "voice.closedHint" : undefined;
  return <>
    <div className="lr-voice-toolbar lr-media-controls" role="group" aria-label={t("interaction.voice")}>
      {joined && <div className="lr-voice-quick-controls">
        <Btn icon={state.microphone ? "microphone" : "microphoneOff"} title="host.device.microphone"
          size="compact" hint={state.capturePending ? "hint-close" : state.role === "host"
            ? state.microphone ? "hint-microphone-off" : "hint-microphone-on"
            : state.microphone ? "hint-voice-microphone-off" : "hint-voice-microphone-on"}
          hintText={microphoneUnavailable ? "voice.error.microphoneUnavailable" : microphoneTitle}
          pressed={state.microphone} busy={state.capturePending} disabled={!state.connected || microphoneUnavailable}
          iconOverlay={state.microphone && !state.capturePending && <svg className="lr-voice-mic-level" viewBox="0 0 24 24" aria-hidden="true">
            <defs><clipPath id={meterId}><rect x="9.7" y="2.7" width="4.6" height="11.6" rx="2.3" /></clipPath></defs>
            <rect x="9.7" y={14.3 - 11.6 * level} width="4.6" height={11.6 * level} clipPath={`url(#${meterId})`} />
          </svg>}
          onClick={() => {
            session.resumeAudio();
            if (state.microphone || state.capturePending) session.stopMicrophone(); else void session.startMicrophone();
          }} />
        <Btn icon={state.deafened ? "headphonesOff" : "headphones"} title="voice.listening"
          size="compact" hint={state.deafened ? "hint-voice-undeafen" : "hint-voice-deafen"}
          hintText={state.deafened ? "voice.undeafenHint" : "voice.deafenHint"}
          pressed={!state.deafened} onClick={() => session.deafen(!state.deafened)} />
      </div>}
      <Btn icon={!joined ? "headphones" : host ? "stop" : "door"}
        title={actionTitle} cap={actionTitle} tone={joined && host ? "danger" : undefined} size="compact"
        hint={actionHint} hintText={actionExplanation}
        disabled={!state.connected || !state.room || !joined && !host && !state.room.enabled}
        onClick={() => { if (!joined) session.resumeAudio(); session.command({ action: joined ? "leave" : "join" }); }} />
    </div>
    {state.autoplayBlocked && <Btn icon="play" title="voice.play" cap="voice.play" size="compact" hint="hint-local-play" onClick={() => session.resumeAudio()} />}
    {state.error && <p className="lr-voice-control-error" role="alert"><Glyph name="alert" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t(`voice.error.${state.error}`)}</span></p>}
  </>;
}

function memberStatus(member: NonNullable<RoomVoiceSnapshot["room"]>["members"][number]): { label: CopyKey; icon: GlyphName } {
  if (!member.connected) return { label: "voice.offline", icon: "wifiOff" };
  if (member.publicationId) return { label: "voice.microphoneActive", icon: "microphone" };
  return member.joined ? { label: "voice.microphoneInactive", icon: "microphoneOff" } : { label: "voice.outside", icon: "door" };
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
  </div>;
}

export function RoomVoicePanel({ session, names, onSelectParticipant, onSettings }: Props & {
  names?: ReadonlyMap<string, string>;
  onSelectParticipant?: (peerId: string, trigger: HTMLButtonElement) => void;
  onSettings: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const levels = useVoiceLevels(session, Boolean(me?.joined));
  const members = labelParticipantNames((state.room?.members ?? []).map(member => ({
    ...member, displayName: names?.get(member.peerId) ?? t("voice.participant"),
  })));
  return <div className="lr-room-voice">
    <div className="lr-voice-panel-tools">
      <span>{vis && <Glyph name="users" size={16} />}
        <span className={vis ? "visually-hidden" : undefined}>{t("voice.participants")}</span></span>
      <Btn icon="sliders" quiet size="dense" title="voice.settings"
        hint="hint-advanced"
        onClick={onSettings} />
    </div>
    {!vis && state.role === "viewer" && !state.room?.enabled && <p className="lr-voice-hint">{t("voice.closedHint")}</p>}
    {state.room?.unavailable.length ? <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.unavailable")}</span></p> : null}
    {!state.connected && <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.reconnecting")}</span></p>}
    <div className="lr-voice-members">
      {members.map(member => {
        const status = memberStatus(member);
        const speaking = !!member.publicationId && (levels.get(member.peerId) ?? 0) > .01;
        return <article className="lr-voice-member" key={member.peerId} data-room-peer={member.peerId}>
          <div className="lr-voice-identity">
            {onSelectParticipant && member.connected ? <Tooltip kind="hint-reaction-picker"
              text={vis ? undefined : t("interaction.withPerson", { name: member.label })}>
              <button type="button" className="lr-voice-avatar"
              aria-label={t("interaction.withPerson", { name: member.label })}
              onClick={event => onSelectParticipant(member.peerId, event.currentTarget)}>
              <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />
            </button></Tooltip> : <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />}
            <div><Tooltip overflow={{ text: member.label, selector: "b" }}><b>{member.label}{member.peerId === state.peerId && <span className={vis ? "visually-hidden" : undefined}>{` · ${t("voice.self")}`}</span>}</b></Tooltip>
              <small><Glyph name={status.icon} size={14} />
                <span className="lr-voice-activity" data-speaking={speaking || undefined} aria-hidden="true" />
                <span className={vis ? "visually-hidden" : undefined}>{t(speaking ? "voice.speaking" : status.label)}</span></small></div>
          </div>
          {member.peerId !== state.peerId && me?.joined && member.joined && <div className="lr-voice-member-controls">
            <Btn icon={state.muted.has(member.peerId) ? "speakerOff" : "speaker"} size="dense"
              title={state.muted.has(member.peerId) ? "voice.unmuteForMe" : "voice.muteForMe"}
              hint={state.muted.has(member.peerId) ? "hint-unmute" : "hint-mute"}
              pressed={state.muted.has(member.peerId)} onClick={() => session.muteVoice(member.peerId)} />
          </div>}
        </article>;
      })}
    </div>
    {vis && <span className="visually-hidden">{t("interaction.voice")}</span>}
  </div>;
}
