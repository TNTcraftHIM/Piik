import { useEffect, useState } from "react";
import { SOURCES, previewSource } from "./ControlsPreview";
import { GuideJoinControls } from "./GuideJoinControls";
import { GuideViewerRouteFailure, GuideShareFailure, GuideRoomVoice } from "./GuideRoomScenes";
import { CaptureSourcePicker } from "../components/living/CaptureSourcePicker";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { CopyRoomInvite, RoomInviteField } from "../components/living/RoomInviteControls";
import { SharingSettings } from "../components/living/SharingSettings";
import { QualityPresets, PictureSettingsSummary } from "../components/living/QualityPresets";
import { QUALITY_PROFILES } from "../media/quality";
import { StageTv } from "../components/living/Stage";
import { Row, RowGroup } from "../components/living/primitives";
import { setCopy, useCopy } from "../ui/copy";
import { applyTheme } from "../ui/theme";

const noop = () => {};

function Launcher({ lan }: { lan: boolean }) {
  const [mode, setMode] = useState<AppMode>(lan ? "local" : "link");
  const [address, setAddress] = useState("192.0.2.30");
  return <div className="lr-client-launch"><LauncherForm mode={mode} onModeChange={setMode}
    localAccessPassword="" onLocalAccessPasswordChange={noop} sites={[]} startupSite="" onToggleStartupSite={noop} onSelectSite={noop} onRemoveSite={noop} onOpen={event => event.preventDefault()}
    onSubmit={event => event.preventDefault()} lan={{ selected: address, onChange: setAddress, addresses: [
      { address: "192.0.2.10", name: "Wi-Fi" },
      { address: "192.0.2.30", name: "Virtual LAN" },
    ] }} /></div>;
}

function Invite() {
  const { t } = useCopy();
  const [includeInviteCredential, setIncludeInviteCredential] = useState(true);
  const roomLink = "https://piik.example/r/9527" + (includeInviteCredential ? "#v=demo" : "");
  const state = { roomLink, includeInviteCredential, roomLinkBlocked: false, roomMutating: false };
  return <div className="cp-guide-invite">
    <Row label={t("host.policy")}>
      <RowGroup actions><CopyRoomInvite {...state} copied={false}
        onCopy={() => void navigator.clipboard.writeText(roomLink).catch(noop)} /></RowGroup>
      <RoomInviteField {...state} onCredentialChange={setIncludeInviteCredential} />
    </Row>
  </div>;
}

function Sources() {
  return <StageTv label="Piik"><CaptureSourcePicker nativeSources={{ ...SOURCES, sources: SOURCES.sources.slice(0, 2) }} browserSupported initialTab="window"
    onBrowser={noop} onCamera={noop} onNative={noop} onPreview={previewSource} onRefresh={noop} onCancel={noop} /></StageTv>;
}

function Settings() {
  const [preset, setPreset] = useState<keyof typeof QUALITY_PROFILES>("1080p30");
  return <SharingSettings id="guide-settings" open
    presets={<QualityPresets selected={preset} onSelect={setPreset} />}
    pictureSummary={<PictureSettingsSummary value={QUALITY_PROFILES[preset]} />} picture={null} audio={null} />;
}

function GuideScene({ scene }: { scene: string | null }) {
  switch (scene) {
    case "app-modes": return <Launcher lan={false} />;
    case "virtual-lan-address": return <Launcher lan />;
    case "invite-copy":
    case "invite-qr": return <Invite />;
    case "share-source":
    case "share-source-confirm": return <Sources />;
    case "sharing-settings": return <Settings />;
    case "room-voice": return <GuideRoomVoice />;
    case "share-failure": return <GuideShareFailure />;
    case "viewer-route-failure": return <GuideViewerRouteFailure />;
    case "join-code":
    case "join-password": return <GuideJoinControls password={scene === "join-password"} />;
    default: return null;
  }
}

export function GuidePreviewPage() {
  const parameters = new URLSearchParams(location.search);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setCopy({ lang: parameters.get("lang") === "zh" ? "zh" : "en", vis: false });
    applyTheme(parameters.get("theme") === "dark" ? "dark" : "light");
    setReady(true);
  }, []);
  if (!ready) return null;
  const scene = parameters.get("scene");
  return <main className="lr-app cp-guide-stage" data-guide-scene={scene}
    data-guide-capture={scene?.startsWith("join-") ? undefined : ""}
    data-guide-ready={scene?.startsWith("join-") ? undefined : ""} data-comic-reduced-motion>
    <GuideScene scene={scene} />
  </main>;
}
