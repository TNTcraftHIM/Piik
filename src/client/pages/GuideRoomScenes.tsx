import { RoomInteractions } from "../components/living/RoomInteractions";
import { ShareFailureHelp } from "../components/living/ShareFailureHelp";
import { StageOverlay } from "../components/living/Stage";
import { deriveViewerPresentation } from "../media/viewer-presentation";
import { useCopy } from "../ui/copy";
import { deriveParticipantStatus, deriveViewerStatus } from "../ui/media-status";
import { hostFailureChecks } from "./host-page-notices";
import { useRoomVoicePreview } from "./RoomVoicePreview";
import { STATUS_SCENARIOS } from "./status-preview-scenarios";
import { usePreviewInteractions } from "./use-preview-interactions";

export function GuideViewerRouteFailure() {
  const { t } = useCopy();
  const { state } = STATUS_SCENARIOS.find(item => item.id === "initial-route-failed")!;
  const presentation = deriveViewerPresentation(state);
  const { overlay } = deriveViewerStatus(presentation, state.signal,
    state.route?.kind === "none" ? null : state.route?.kind);
  if (!overlay) return null;
  return <div className="lr-tv-screen" style={{ position: "relative", width: "min(440px, 88vw)", height: 220 }}>
    <StageOverlay icon={overlay.status.icon} comic={overlay.status.comic} tone={overlay.status.tone}
      message={t(overlay.status.labelKey)} viewerStage={presentation.stage} dim={overlay.mode === "blocking"} />
  </div>;
}

export function GuideShareFailure() {
  const { t } = useCopy();
  const code = "app/start-share/rejected";
  const labelKey = "native.fail.captureStart";
  return <ShareFailureHelp code={code} checks={hostFailureChecks(code)} label={t(labelKey)}
    status={{ icon: "alert", tone: "bad", tooltip: "source-failed", labelKey }} />;
}

export function GuideRoomVoice() {
  const { session } = usePreviewInteractions(false);
  const voice = useRoomVoicePreview(false);
  return <div className="lr-scene"><RoomInteractions session={session} voice={voice} voiceState={voice.room}
    view="host" host={{ key: "preview-host", name: "Piik", you: true }}
    entries={[{ key: "preview-friend", name: "Piik friend",
      status: deriveParticipantStatus({ upstream: { kind: "peer", peerId: "preview-host" }, mediaReady: true }, true) }]} />
  </div>;
}
