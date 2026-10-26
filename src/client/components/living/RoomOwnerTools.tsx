import { useEffect, useRef, useState } from "react";
import { MAX_VIEWER_PASSWORD_LENGTH, viewerPasswordSchema, type RoomAccessUpdateRequest } from "../../../shared/protocol";
import { updateRoomAccess } from "../../lib/api";
import { replaceViewerInvite } from "../../lib/session";
import { useRoomControl, type RoomControlSession } from "../../lib/room-control";
import { useCopy } from "../../ui/copy";
import { roomAdmission } from "./RoomChip";
import { Pill } from "./primitives";
import { RoomAdmissionControls } from "./RoomAdmissionControls";

// The room owner keeps the same admission tools while watching another member.
export function RoomOwnerTools({ session }: { session: RoomControlSession }) {
  const { t } = useCopy();
  const snapshot = useRoomControl(session);
  const state = snapshot.state;
  const [busy, setBusy] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [savedPassword, setSavedPassword] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [includeCredential, setIncludeCredential] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  const copyRequest = useRef<object | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const link = includeCredential ? invite : session.canonicalUrl;
  const linkBlocked = !includeCredential && state?.codeEntryPolicy === "private" && !state.viewerPasswordEnabled;
  useEffect(() => {
    copyRequest.current = null;
    setCopied(false);
    return () => {
      copyRequest.current = null;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, [link]);

  async function update(request: RoomAccessUpdateRequest) {
    const token = session.ownerToken;
    if (!token || busy || !snapshot.connected) return;
    setBusy(true); setResult(null);
    try {
      const response = await updateRoomAccess(session.roomId, token, request);
      if (session.ownerToken !== token) return;
      if (response.type === "viewer-grant-updated") {
        setInvite(response.inviteUrl);
        setIncludeCredential(!!response.inviteUrl);
        replaceViewerInvite(session.roomId, response.inviteUrl);
      }
      if (request.action === "set-viewer-password") {
        setSavedPassword(request.password ?? null);
        setPassword(request.password ?? "");
        setPasswordVisible(false);
      }
      setResult({ text: t("room.control.saved"), failed: false });
    } catch (error) {
      if (session.ownerToken === token) setResult({ text: error instanceof Error ? error.message : t("host.accessFailed"), failed: true });
    } finally { setBusy(false); }
  }
  async function copyLink() {
    if (!link || linkBlocked || busy) return;
    const token = session.ownerToken;
    const request = {};
    copyRequest.current = request;
    try {
      await navigator.clipboard.writeText(link);
      if (copyRequest.current !== request || session.ownerToken !== token) return;
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      if (copyRequest.current === request && session.ownerToken === token) setResult({ text: t("host.invite.copyFailed"), failed: true });
    }
  }
  if (!state || state.ownerPeerId !== snapshot.peerId) return null;
  return <>
    <RoomAdmissionControls roomLink={link} inviteAvailable={!!invite} revokeAvailable
      roomLinkBlocked={linkBlocked} copied={copied} includeInviteCredential={includeCredential}
      roomMutating={busy || !snapshot.connected} activeCodeEntryPolicy={state.codeEntryPolicy}
      viewerPasswordEnabled={state.viewerPasswordEnabled} passwordOpen={passwordOpen}
      viewerPasswordDraft={password} viewerPasswordVisible={passwordVisible} savedPassword={savedPassword}
      copyRoomLink={copyLink}
      changeViewerGrant={action => update({ action: action === "rotate" ? "rotate-viewer-grant" : "revoke-viewer-grant" })}
      changeCodeEntryPolicy={policy => policy === state.codeEntryPolicy ? Promise.resolve() : update({ action: "set-code-entry-policy", policy })}
      changeViewerPassword={async value => {
        if (value !== null && !viewerPasswordSchema.safeParse(value).success) {
          setResult({ text: t("host.password.rule", { max: String(MAX_VIEWER_PASSWORD_LENGTH) }), failed: true });
          return;
        }
        await update({ action: "set-viewer-password", password: value });
      }}
      setIncludeInviteCredential={setIncludeCredential} setPasswordOpen={setPasswordOpen}
      setViewerPasswordDraft={setPassword} setViewerPasswordVisible={setPasswordVisible} />
    {result && <div className="lr-notices" role="status"><Pill icon={result.failed ? "alert" : "check"}
      label={result.text} comic={result.failed ? "settings-failed" : roomAdmission(state.codeEntryPolicy, state.viewerPasswordEnabled).comic} tone={result.failed ? "bad" : "live"} /></div>}
  </>;
}
