import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_QUALITY_SETTINGS, DEFAULT_ROUTE_POLICY, type ParticipantPresenceEntry } from "../../../shared/protocol";
import { RoomControlSession, useRoomControl } from "../../lib/room-control";
import type { SignalingClient } from "../../lib/signaling";
import { captureBrowserSource, type BrowserCaptureSource } from "../../media/quality";
import { HostAudio } from "../../media/host-audio";
import { automaticVideoCodecPreference } from "../../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../../webrtc/video-codec-preflight";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import { CaptureSourcePicker } from "./CaptureSourcePicker";
import "./room-control.css";

export function RoomControls({ session, participants, signal, stage }: {
  session: RoomControlSession | null;
  participants: readonly ParticipantPresenceEntry[];
  signal?: SignalingClient | null;
  stage?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useCopy();
  const snapshot = useRoomControl(session);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captureError, setCaptureError] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const state = snapshot.state;
  const allowed = state?.members.some(member => member.peerId === snapshot.peerId && member.sharingAllowed);
  useEffect(() => { if (!allowed) { operation.current?.abort(); setPicker(false); } }, [allowed]);
  if (!session || !state) return null;
  const transfer = state.transfer;
  const recipient = transfer?.targetPeerId === snapshot.peerId;
  const sender = transfer?.fromPeerId === snapshot.peerId;
  const name = (peerId: string) => participants.find(person => person.peerId === peerId)?.displayName ?? t("common.viewers");

  async function share(source: BrowserCaptureSource, deviceId?: string) {
    if (!signal || busy) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setCaptureError(false);
    let capture: MediaStream | null = null, audio: HostAudio | null = null;
    let handedOff = false;
    try {
      capture = await captureBrowserSource(DEFAULT_QUALITY_SETTINGS, source, deviceId);
      if (controller.signal.aborted) return;
      audio = new HostAudio(capture, source);
      const stream = await audio.start();
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("Capture ended");
      const codec = automaticVideoCodecPreference(await preferredVideoCodecForTrack(track, DEFAULT_QUALITY_SETTINGS, controller.signal));
      if (controller.signal.aborted || track.readyState !== "live") return;
      handedOff = signal.claimPresentation({ stream, audio, codec }, DEFAULT_QUALITY_SETTINGS, DEFAULT_ROUTE_POLICY);
      if (!handedOff) throw new Error("Share unavailable");
      setPicker(false);
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "NotAllowedError")) setCaptureError(true);
    } finally {
      if (!handedOff) { capture?.getTracks().forEach(track => track.stop()); audio?.dispose(); }
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    }
  }

  return <div className="lr-room-control">
    {allowed && signal && <div className="lr-room-control-row">
      <Btn icon="display" cap="room.control.share" title="room.control.share" expanded={picker} disabled={!snapshot.connected || busy}
        onClick={() => setPicker(value => !value)} />
      <span className="lr-room-control-note">{t("room.control.shareHint")}</span>
    </div>}
    {picker && stage?.current && createPortal(<CaptureSourcePicker nativeSources={{ kind: "browser" }} initialTab="browser"
      browserAvailable={!!navigator.mediaDevices?.getDisplayMedia} cameraAvailable={!!navigator.mediaDevices?.getUserMedia}
      onBrowser={() => void share("browser")} onCamera={deviceId => void share("camera", deviceId)}
      onNative={() => {}} onPreview={async () => null} onRefresh={() => {}} selectionDisabled={busy}
      onCancel={() => { operation.current?.abort(); setPicker(false); }} />, stage.current)}
    {transfer && (recipient || sender) && <div className="lr-room-control-offer" role="status">
      <p>{t(recipient ? "room.control.offer" : "room.control.waiting", { name: name(recipient ? transfer.fromPeerId : transfer.targetPeerId) })}</p>
      {recipient && <p className="lr-room-control-note">{t("room.control.offerHint")}</p>}
      <div className="lr-room-control-row">
        {recipient && <Btn icon="check" cap="room.control.accept" title="room.control.accept" busy={snapshot.accepting} disabled={!snapshot.connected || snapshot.accepting} onClick={() => void session.accept()} />}
        <Btn icon="x" cap={recipient ? "room.control.decline" : "common.cancel"} title={recipient ? "room.control.decline" : "common.cancel"}
          disabled={!snapshot.connected || snapshot.accepting} onClick={() => session.command({ action: recipient ? "decline-transfer" : "cancel-transfer", offerId: transfer.id })} />
      </div>
    </div>}
    {(snapshot.error || captureError) && <p className="lr-room-control-error" role="alert">{t(captureError ? "room.control.captureFailed" : `room.control.error.${snapshot.error!}`)}</p>}
  </div>;
}

export function MemberRoomControls({ session, peerId }: { session: RoomControlSession | null; peerId?: string }) {
  const snapshot = useRoomControl(session);
  const { t } = useCopy();
  const member = snapshot.state?.members.find(member => member.peerId === peerId);
  if (!session || !member || snapshot.state?.ownerPeerId !== snapshot.peerId || peerId === snapshot.peerId) return null;
  return <div className="lr-member-control">
    <Btn icon="display" cap={member.sharingAllowed ? "room.control.revoke" : "room.control.grant"}
      title={member.sharingAllowed ? "room.control.revoke" : "room.control.grant"} size="dense" pressed={member.sharingAllowed}
      disabled={!snapshot.connected || !member.supported} onClick={() => session.command({ action: "grant-sharing", peerId: member.peerId, allowed: !member.sharingAllowed })} />
    <Btn icon="key" cap="room.control.transfer" title="room.control.transfer" size="dense" disabled={!snapshot.connected || !member.supported}
      onClick={() => session.command({ action: "transfer-owner", peerId: member.peerId })} />
    {!member.supported && <p className="lr-room-control-note">{t("room.control.updateRequired")}</p>}
  </div>;
}
