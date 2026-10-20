import { useSyncExternalStore } from "react";
import { Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { labelParticipantNames } from "../lib/viewer-presence";
import { useCopy, type CopyKey } from "../ui/copy";
import { Glyph, type GlyphName } from "../ui/icons";
import type { RoomVoiceSession, RoomVoiceSnapshot } from "./session";
import "./room-voice.css";

export type RoomVoiceView = Pick<RoomVoiceSession, "subscribe" | "getSnapshot" | "resumeAudio" | "command" |
  "startMicrophone" | "stopMicrophone" | "muteVoice" | "deafen">;
interface Props { session: RoomVoiceView }

export function RoomVoiceControls({ session }: Props) {
  const { t, vis } = useCopy();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const microphoneTitle = state.capturePending ? "voice.captureCancel" : state.microphone ? "voice.microphoneOff" : "voice.microphoneOn";
  return <>
    {!me?.listen ? <Btn icon={me?.requested ? "x" : "microphone"} size="compact"
      title={me?.requested ? "voice.cancel" : state.role === "host" ? "voice.join" : "voice.request"}
      cap={me?.requested ? "voice.cancel" : state.role === "host" ? "voice.join" : "voice.request"}
      disabled={!state.connected || !state.room}
      hint={me?.requested ? "hint-voice-leave" : "hint-voice-join"}
      onClick={() => { session.resumeAudio(); session.command({ action: me?.requested ? "leave" : "join" }); }} /> : <div className="lr-voice-toolbar" role="group" aria-label={t("interaction.voice")}>
      <span className="lr-voice-joined"><Glyph name="signal" size={16} />
        <span className={vis ? "visually-hidden" : undefined}>{t("voice.joined")}</span></span>
      <div className="lr-voice-quick-controls lr-media-controls">
        <Btn icon={state.microphone ? "microphone" : "microphoneOff"} title={microphoneTitle}
          size="compact" hint={state.role === "host"
            ? state.microphone ? "hint-microphone-off" : "hint-microphone-on"
            : state.microphone ? "hint-voice-microphone-off" : "hint-voice-microphone-on"}
          hintText={state.deafened ? "voice.undeafenFirst" : !me.speak ? "voice.speakNotAllowed" : undefined}
          pressed={state.microphone} busy={state.capturePending} disabled={!me.speak || !state.connected || state.deafened}
          onClick={() => {
            session.resumeAudio();
            if (state.microphone || state.capturePending) session.stopMicrophone(); else void session.startMicrophone();
          }} />
        <Btn icon={state.deafened ? "headphonesOff" : "headphones"} title={state.deafened ? "voice.undeafen" : "voice.deafen"}
          size="compact" hint={state.deafened ? "hint-voice-undeafen" : "hint-voice-deafen"}
          hintText={state.deafened ? "voice.undeafenHint" : "voice.deafenHint"}
          pressed={!state.deafened} onClick={() => session.deafen(!state.deafened)} />
        <Btn icon="door" title="voice.leave" size="compact" quiet hint="hint-voice-leave" disabled={!state.connected}
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
  if (member.listen) return member.speak ? { label: "voice.canSpeak", icon: "microphoneOff" } : { label: "voice.listening", icon: "headphones" };
  return member.requested ? { label: "voice.pending", icon: "clock" } : { label: "voice.outside", icon: "door" };
}

// Capture and transport belong to the session above this movable window.
export function RoomVoicePanel({ session, names }: Props & { names?: ReadonlyMap<string, string> }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const me = state.room?.members.find(member => member.peerId === state.peerId);
  const members = labelParticipantNames((state.room?.members ?? []).map(member => ({
    ...member, displayName: names?.get(member.peerId) ?? t("voice.participant"),
  })));
  return <div className="lr-room-voice">
    {!vis && <p className="lr-voice-hint">{t("voice.hint")}</p>}
    {state.room?.unavailable.length ? <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.unavailable")}</span></p> : null}
    {!state.connected && <p className="lr-voice-hint" role="status"><Glyph name="network" size={16} />
      <span className={vis ? "visually-hidden" : undefined}>{t("voice.reconnecting")}</span></p>}
    <div className="lr-voice-members">
      {members.map(member => {
        const status = memberStatus(member);
        return <article className="lr-voice-member" key={member.peerId}>
          <div className="lr-voice-identity">
            <PawnSvg color={participantColor(member.peerId)} identity={member.peerId} host={member.peerId === state.room?.hostPeerId} />
            <div><b>{member.label}{member.peerId === state.peerId && <span className={vis ? "visually-hidden" : undefined}>{` · ${t("voice.self")}`}</span>}</b>
              <small><Glyph name={status.icon} size={14} /><span className={vis ? "visually-hidden" : undefined}>{t(status.label)}</span></small></div>
          </div>
          {member.peerId !== state.peerId && <div className="lr-voice-member-controls">
            {me?.listen && member.listen && <Btn icon={state.muted.has(member.peerId) ? "speakerOff" : "speaker"} size="dense"
              title={state.muted.has(member.peerId) ? "voice.unmuteForMe" : "voice.muteForMe"}
              cap={state.muted.has(member.peerId) ? "voice.unmuteForMe" : "voice.muteForMe"}
              hint={state.muted.has(member.peerId) ? "hint-unmute" : "hint-mute"}
              pressed={state.muted.has(member.peerId)} onClick={() => session.muteVoice(member.peerId)} />}
            {state.role === "host" && member.requested && <>
              {!member.listen && <Btn icon="headphones" title="voice.allowListen" cap="voice.allowListen" size="dense" hint="hint-voice-allow-listen"
                disabled={!state.connected || !member.connected}
                onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: true, speak: false })} />}
              <Btn icon={member.speak ? "microphoneOff" : "microphone"} size="dense"
                title={member.speak ? "voice.revokeSpeak" : "voice.allowSpeak"} cap={member.speak ? "voice.revokeSpeak" : "voice.allowSpeak"}
                hint={member.speak ? "hint-voice-revoke-speak" : "hint-voice-allow-speak"}
                hintText={member.speak ? undefined : "voice.allowSpeakHint"}
                disabled={!state.connected || !member.connected}
                onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: true, speak: !member.speak })} />
              <Btn icon="x" title={member.listen ? "voice.remove" : "voice.decline"} cap={member.listen ? "voice.remove" : "voice.decline"}
                size="dense" hint="hint-voice-remove" disabled={!state.connected}
                onClick={() => session.command({ action: "permission", peerId: member.peerId, listen: false, speak: false })} />
            </>}
          </div>}
        </article>;
      })}
    </div>
    {vis && <span className="visually-hidden">{t("interaction.voice")}</span>}
  </div>;
}
