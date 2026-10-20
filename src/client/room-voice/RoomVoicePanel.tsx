import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { Tooltip } from "../components/living/Tooltip";
import { participantColor } from "../components/living/participant-color";
import { labelParticipantNames } from "../lib/viewer-presence";
import { useCopy, type CopyKey } from "../ui/copy";
import { Glyph, type GlyphName } from "../ui/icons";
import type { RoomVoiceSession, RoomVoiceSnapshot } from "./session";
import "./room-voice.css";
import { MicrophoneSettings } from "../components/living/MicrophoneSettings";

export type RoomVoiceView = Pick<RoomVoiceSession, "subscribe" | "getSnapshot" | "resumeAudio" | "command" |
  "startMicrophone" | "stopMicrophone" | "muteVoice" | "deafen" | "configureInput" | "setVolume" | "activity" | "microphones">;
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
  return <>
    {!me?.joined ? <Btn icon="headphones" size="compact"
      title={state.role === "host" ? "voice.open" : "voice.join"}
      cap={state.role === "host" ? "voice.open" : "voice.join"}
      disabled={!state.connected || !state.room || state.role === "viewer" && !state.room.enabled}
      hint={state.role === "host" ? "hint-voice-open" : "hint-voice-join"}
      hintText={state.role === "host" ? "voice.openHint" : !state.room?.enabled ? "voice.closedHint" : undefined}
      onClick={() => { session.resumeAudio(); session.command({ action: "join" }); }} /> : <div className="lr-voice-toolbar" role="group" aria-label={t("interaction.voice")}>
      <span className="lr-voice-joined"><Glyph name="signal" size={16} />
        <span className={vis ? "visually-hidden" : undefined}>{t("voice.joined")}</span></span>
      <div className="lr-voice-quick-controls lr-media-controls">
        <span className="lr-voice-mic"><Btn icon={state.microphone ? "microphone" : "microphoneOff"} title={microphoneTitle}
          size="compact" hint={state.role === "host"
            ? state.microphone ? "hint-microphone-off" : "hint-microphone-on"
            : state.microphone ? "hint-voice-microphone-off" : "hint-voice-microphone-on"}
          pressed={state.microphone} busy={state.capturePending} disabled={!state.connected}
          onClick={() => {
            session.resumeAudio();
            if (state.microphone || state.capturePending) session.stopMicrophone(); else void session.startMicrophone();
          }} />
          {state.microphone && <svg className="lr-voice-mic-level" viewBox="0 0 24 24" aria-hidden="true">
            <defs><clipPath id={meterId}><rect x="9.7" y="2.7" width="4.6" height="11.6" rx="2.3" /></clipPath></defs>
            <rect x="9.7" y={14.3 - 11.6 * level} width="4.6" height={11.6 * level} clipPath={`url(#${meterId})`} />
          </svg>}
        </span>
        <Btn icon={state.deafened ? "headphonesOff" : "headphones"} title={state.deafened ? "voice.undeafen" : "voice.deafen"}
          size="compact" hint={state.deafened ? "hint-voice-undeafen" : "hint-voice-deafen"}
          hintText={state.deafened ? "voice.undeafenHint" : "voice.deafenHint"}
          pressed={!state.deafened} onClick={() => session.deafen(!state.deafened)} />
        <Btn icon="door" title={state.role === "host" ? "voice.close" : "voice.leave"} size="compact" quiet
          hint={state.role === "host" ? "hint-voice-close" : "hint-voice-leave"}
          hintText={state.role === "host" ? "voice.closeHint" : undefined} disabled={!state.connected}
          onClick={() => session.command({ action: "leave" })} />
      </div>
    </div>}
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
export function RoomVoicePanel({ session, names, onSelectParticipant }: Props & {
  names?: ReadonlyMap<string, string>;
  onSelectParticipant?: (peerId: string, trigger: HTMLButtonElement) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { t, vis } = useCopy();
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const levels = useVoiceLevels(session, Boolean(me?.joined) && !settingsOpen);
  const members = labelParticipantNames((state.room?.members ?? []).map(member => ({
    ...member, displayName: names?.get(member.peerId) ?? t("voice.participant"),
  })));
  return <div className="lr-room-voice">
    <div className="lr-voice-panel-tools">
      <span>{t(settingsOpen ? "host.microphone.settings" : "voice.participants")}</span>
      <Btn icon={settingsOpen ? "headphones" : "sliders"} quiet size="dense"
        title={settingsOpen ? "voice.settingsClose" : "host.microphone.settings"}
        cap={settingsOpen ? "voice.settingsClose" : undefined}
        hint={settingsOpen ? "hint-collapse" : state.role === "host" ? "hint-microphone-processing" : "hint-voice-microphone-processing"} expanded={settingsOpen}
        onClick={() => setSettingsOpen(value => !value)} />
    </div>
    {settingsOpen ? <MicrophoneSettings host={state.role === "host"} enabled={state.microphone} disabled={state.capturePending}
      loadDevices={session.microphones} deviceId={state.input.deviceId} onDevice={deviceId => void session.configureInput({ deviceId })}
      volume={state.input.volume} onVolume={value => session.setVolume(value)}
      voiceProcessing={state.input.voiceProcessing} onVoiceProcessing={voiceProcessing => void session.configureInput({ voiceProcessing })} /> : <>
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
            {onSelectParticipant && member.connected ? <button type="button" className="lr-voice-avatar"
              aria-label={t("interaction.withPerson", { name: member.label })}
              onClick={event => onSelectParticipant(member.peerId, event.currentTarget)}>
              <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />
            </button> : <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />}
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
    </>}
    {vis && <span className="visually-hidden">{t("interaction.voice")}</span>}
  </div>;
}
