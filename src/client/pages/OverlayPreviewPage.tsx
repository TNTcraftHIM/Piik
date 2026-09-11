import { StageOverlay, StageTv } from "../components/living/Stage";
import { AppHeader } from "../components/living/Header";
import { useCopy } from "../ui/copy";
import type { ComicKind } from "../components/living/Comic";
import type { GlyphName } from "../ui/icons";

const STATES: readonly {
  title: string;
  comic: ComicKind;
  icon: GlyphName;
  message: string;
  progress?: string;
}[] = [
  { title: "首次连接", comic: "connecting-p2p", icon: "loader", message: "正在连接" },
  { title: "第一次重试", comic: "connecting-p2p", icon: "loader", message: "正在重试", progress: "1/2" },
  { title: "SFU 连接", comic: "connecting-sfu", icon: "loader", message: "正在连接中转" },
  { title: "等待房主", comic: "waiting-for-host", icon: "door", message: "等待房主" },
  { title: "房主暂停", comic: "host-paused", icon: "pause", message: "房主已暂停" },
  { title: "线路恢复", comic: "recovering", icon: "refresh", message: "正在恢复线路" },
  { title: "线路失败", comic: "route-failed", icon: "alert", message: "线路不可用" },
  { title: "播放失败", comic: "playback-failed", icon: "alert", message: "播放失败" },
  { title: "没有声音", comic: "no-audio", icon: "speaker", message: "没有可用音频" },
  { title: "房主离线", comic: "host-offline", icon: "door", message: "房主已离开" },
  { title: "带宽受限", comic: "bandwidth-limited", icon: "gauge", message: "线路受到带宽限制" },
  { title: "编码受限", comic: "encoder-limited", icon: "tv", message: "编码受到限制" },
];

export function OverlayPreviewPage() {
  const { vis } = useCopy();
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-room lr-overlay-preview">
        <header className="lr-overlay-preview-head">
          <h1>Overlay preview</h1>
          <p>{vis ? "状态漫画与重试提示预览" : "Stage overlay states"}</p>
        </header>
        <div className="lr-overlay-preview-grid">
          {STATES.map((state) => (
            <section className="lr-overlay-preview-card" key={state.title}>
              <h2>{state.title}</h2>
              <StageTv label={state.message}>
                <StageOverlay
                  icon={state.icon}
                  comic={state.comic}
                  message={state.message}
                  progress={state.progress}
                  spin={state.icon === "loader"}
                  transition={state.icon === "loader"}
                  dim
                />
              </StageTv>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
