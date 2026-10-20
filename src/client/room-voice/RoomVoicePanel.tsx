import { useSyncExternalStore } from "react";
import { Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { useCopy, type CopyKey } from "../ui/copy";
import { Glyph } from "../ui/icons";
import type { RoomVoiceSession, RoomVoiceSnapshot } from "./session";
import "./room-voice.css";

interface Props { session: RoomVoiceSession }

export function RoomVoiceControls({ session }: Props) {
  const { t } = useCopy();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const microphoneTitle = state.capturePending ? "voice.captureCancel" : state.microphone ? "voice.microphoneOff" : "voice.microphoneOn";
  return <>
    {!me?.listen ? <Btn icon={me?.requested ? "x" : "microphone"} size="compact"
      title={me?.requested ? "voice.cancel" : state.role === "host" ? "voice.join" : "voice.request"}
      cap={me?.requested ? "voice.cancel" : state.role === "host" ? "voice.join" : "voice.request"}
      disabled={!state.connected || !state.room}
      onClick={() => { session.resumeAudio(); session.command({ action: me?.requested ? "leave" : "join" }); }} /> : <>
      <Btn icon={state.microphone ? "microphone" : "microphoneOff"} title={microphoneTitle} cap={microphoneTitle}
        size="compact" hint={state.microphone ? "hint-microphone-off" : "hint-microphone-on"}
        pressed={state.microphone} busy={state.capturePending} disabled={!me.speak || !state.connected}
        onClick={() => {
          session.resumeAudio();
          if (state.microphone || state.capturePending) session.stopMicrophone(); else void session.startMicrophone();
        }} />
      <Btn icon="door" title="voice.leave" cap="voice.leave" size="compact" disabled={!state.connected}
        onClick={() => session.command({ action: "leave" })} />
    </>}
    {state.autoplayBlocked && <Btn icon="play" title="voice.play" cap="voice.play" size="compact" onClick={() => session.resumeAudio()} />}
    {state.error && <p className="lr-voice-control-error" role="alert"><Glyph name="alert" size={16} />{t(`voice.error.${state.error}`)}</p>}
  </>;
}

function memberStatus(state: RoomVoiceSnapshot, peerId: string): CopyKey {
  const member = state.room!.members.find(member => member.peerId === peerId)!;
  if (!member.connected) return "voice.offline";
  return member.publicationId ? "voice.microphoneActive" : member.listen ? member.speak ? "voice.canSpeak" : "voice.listening"
    : member.requested ? "voice.pending" : "voice.outside";
}

// Capture and transport belong to the session above this movable window.
export function RoomVoicePanel({ session, names }: Props & { names?: ReadonlyMap<string, string> }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  return <div className="lr-room-voice">
    <p className="lr-voice-hint">{t("voice.hint")}</p>
    {state.room?.unavailable.length ? <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />{t("voice.unavailable")}</p> : null}
    {!state.connected && <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />{t("voice.reconnecting")}</p>}
    <div className="lr-voice-members">
      {state.room?.members.map(member => <article className="lr-voice-member" key={member.peerId}>
        <div className="lr-voice-identity">
          <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />
          <div><b>{names?.get(member.peerId) ?? t("voice.participant")}{member.peerId === state.peerId ? ` · ${t("voice.self")}` : ""}</b>
            <small>{t(memberStatus(state, member.peerId))}</small></div>
        </div>
        {member.peerId !== state.peerId && <div className="lr-voice-member-controls">
          {me?.listen && member.listen && <Btn icon={state.muted.has(member.peerId) ? "speakerOff" : "speaker"} size="dense"
            title={state.muted.has(member.peerId) ? "voice.unmuteForMe" : "voice.muteForMe"}
            cap={state.muted.has(member.peerId) ? "voice.unmuteForMe" : "voice.muteForMe"}
            pressed={state.muted.has(member.peerId)} onClick={() => session.muteVoice(member.peerId)} />}
          {state.role === "host" && member.requested && <>
            {!member.listen && <Btn icon="check" title="voice.allowListen" cap="voice.allowListen" size="dense"
              disabled={!state.connected || !member.connected}
              onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: true, speak: false })} />}
            <Btn icon={member.speak ? "microphoneOff" : "microphone"} size="dense"
              title={member.speak ? "voice.revokeSpeak" : "voice.allowSpeak"} cap={member.speak ? "voice.revokeSpeak" : "voice.allowSpeak"}
              disabled={!state.connected || !member.connected}
              onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: true, speak: !member.speak })} />
            <Btn icon="x" title={member.listen ? "voice.remove" : "voice.decline"} cap={member.listen ? "voice.remove" : "voice.decline"}
              size="dense" disabled={!state.connected}
              onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: false, speak: false })} />
          </>}
        </div>}
      </article>)}
    </div>
    {vis && <span className="visually-hidden">{t("interaction.voice")}</span>}
  </div>;
}
