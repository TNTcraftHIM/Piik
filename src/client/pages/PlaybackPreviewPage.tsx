import { useEffect, useRef, useState } from "react";
import type { VideoFit, VideoRotation } from "../media/video-geometry";
import { AppHeader } from "../components/living/Header";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { RemoteControl } from "../components/living/RemoteControl";
import { RoomChatOverlay, RoomChatToggle } from "../components/living/RoomChatOverlay";
import { StageOverlay, StageTv } from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { STATUS_CATALOG } from "../ui/media-status";
import { useCopy } from "../ui/copy";
import { usePreviewInteractions } from "./use-preview-interactions";
import { PreviewRemoteInput } from "./preview-remote-input";

type PreviewRole = "host" | "viewer";

function testMedia(withAudio: boolean, portrait: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = portrait ? 480 : 640;
  // A 4:3 picture makes contain, crop and stretch visible in the 16:9 player.
  canvas.height = portrait ? 640 : 480;
  const paint = canvas.getContext("2d")!;
  const started = performance.now();
  let animation = 0;
  function draw(now: number) {
    paint.setTransform(canvas.width / 640, 0, 0, canvas.height / 480, 0, 0);
    const seconds = (now - started) / 1000;
    paint.fillStyle = "#172c3b";
    paint.fillRect(0, 0, 640, 480);
    paint.fillStyle = "#29475b";
    paint.fillRect(0, 340, 640, 140);
    paint.fillStyle = "#9de8bf";
    paint.beginPath();
    paint.arc(320 + Math.sin(seconds) * 190, 240, 26, 0, Math.PI * 2);
    paint.fill();
    paint.fillStyle = "#dfe8f2";
    paint.font = "24px monospace";
    paint.fillText(`${seconds.toFixed(1)} s`, 28, 44);
    paint.font = "18px monospace";
    paint.fillText("TOP LEFT", 28, 76);
    paint.fillText("TOP RIGHT", 510, 44);
    paint.fillText("BOTTOM LEFT", 28, 452);
    paint.fillText("BOTTOM RIGHT", 480, 452);
    animation = requestAnimationFrame(draw);
  }
  draw(started);
  const stream = canvas.captureStream(30);
  let audio: AudioContext | undefined;
  let gain: GainNode | undefined;
  if (withAudio) {
    audio = new AudioContext();
    const tone = audio.createOscillator();
    gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    tone.frequency.value = 220;
    gain.gain.value = 0.02;
    tone.connect(gain).connect(destination);
    tone.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
  }
  return {
    stream,
    audio,
    setAudioInput(available: boolean) { if (gain) gain.gain.value = available ? 0.02 : 0; },
    stop() {
      cancelAnimationFrame(animation);
      stream.getTracks().forEach((track) => track.stop());
      if (audio) void audio.close();
    },
  };
}

export function PlaybackPreviewPage() {
  const { lang } = useCopy();
  const english = lang === "en";
  const [role, setRole] = useState<PreviewRole>(() => new URLSearchParams(location.search).get("role") === "host" ? "host" : "viewer");
  function chooseRole(next: PreviewRole) {
    const url = new URL(location.href);
    url.searchParams.set("role", next);
    history.replaceState(history.state, "", url);
    setRole(next);
  }
  return <div className="lr-app">
    <AppHeader homeHref={`/__playback-preview?role=${role}`} />
    <header className="lr-room" style={{ flex: "none", paddingBottom: 0, paddingTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
      <h1 style={{ margin: 0 }}>{english ? "Playback controls" : "播放控件预览"}</h1>
      <div className="lr-toggle" role="group" aria-label={english ? "Preview role" : "预览角色"}>
        {(["host", "viewer"] as const).map(value => <label key={value}>
          <input type="radio" name="playback-preview-role" value={value} checked={role === value} onChange={() => chooseRole(value)} />
          <span>{value === "host" ? english ? "Host preview" : "房主本机预览" : english ? "Viewer playback" : "观众播放"}</span>
        </label>)}
      </div>
      </div>
      <p>{role === "host" ? english ? "Host playback starts muted. This local video and chat sample opens no room, microphone or screen capture."
        : "房主本机预览默认静音。仅本机示例画面与消息，不开房间、不访问麦克风、不采集屏幕。"
        : english ? "Viewer playback and connection settings, with local sample video and messages. No room or capture is opened."
          : "观众播放与连接设置，使用本机示例画面与消息，不开房间、不采集屏幕。"}</p>
    </header>
    <PlaybackSample key={role} role={role} />
  </div>;
}

function PlaybackSample({ role }: { role: PreviewRole }) {
  const { lang, t } = useCopy();
  const english = lang === "en";
  const viewer = role === "viewer";
  const [remote, setRemote] = useState(() => new URLSearchParams(location.search).get("remote") === "1");
  const [remoteInput, setRemoteInput] = useState<PreviewRemoteInput | null>(null);
  const { session, receiveSample } = usePreviewInteractions(viewer);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<ReturnType<typeof testMedia> | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [theaterMode, setTheaterMode] = useTheaterMode();
  const [pictureFit, setPictureFit] = useState<VideoFit>("contain");
  const [pictureRotation, setPictureRotation] = useState<VideoRotation>(0);
  const [viewerRoute, setViewerRoute] = useState<"auto" | "p2p" | "sfu">("auto");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(true);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [portraitSource, setPortraitSource] = useState(false);
  const hasAudio = Boolean(stream?.getAudioTracks().length);

  function play() {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch((cause: unknown) => {
      if (video.srcObject === stream) setError(String(cause));
    });
  }

  function start(withAudio: boolean, portrait = portraitSource) {
    mediaRef.current?.stop();
    const media = testMedia(withAudio, portrait);
    mediaRef.current = media;
    setError("");
    setWaiting(false);
    setStream(media.stream);
    setAudioAvailable(withAudio);
    if (media.audio) void media.audio.resume().catch((cause: unknown) => setError(String(cause)));
  }

  useEffect(() => {
    const video = videoRef.current!;
    video.srcObject = stream;
    if (stream) play();
  }, [stream]);
  useEffect(() => () => mediaRef.current?.stop(), []);
  useEffect(() => {
    const input = new PreviewRemoteInput();
    setRemoteInput(input);
    return () => input.close();
  }, []);

  return <main className={`lr-room${theaterMode ? " is-theater" : ""}`}>
      {!theaterMode ? <header style={{ margin: "20px 0" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="lr-btn" type="button" onClick={() => start(false)}>
            {english ? "Start picture only" : "开启无声测试画面"}</button>
          <button className="lr-btn" type="button" aria-pressed={waiting} onClick={() => setWaiting(value => !value)}>
            {english ? "Connection overlay" : "连接遮罩"}</button>
          <button className="lr-btn" type="button" disabled={!stream} onClick={() => start(!hasAudio)}>
            {hasAudio ? (english ? "Remove audio track" : "移除音轨") : (english ? "Add quiet test tone" : "加入轻音量测试音")}</button>
          <button className="lr-btn" type="button" disabled={!stream} onClick={() => start(hasAudio)}>
            {english ? "Rebind new stream" : "重新绑定新流"}</button>
          <button className="lr-btn" type="button" disabled={!stream} onClick={() => {
            setPortraitSource(!portraitSource); start(hasAudio, !portraitSource);
          }}>{portraitSource ? (english ? "Use landscape source" : "切换横向画面") : (english ? "Use portrait source" : "切换竖向画面")}</button>
          <button className="lr-btn" type="button" disabled={!hasAudio} onClick={() => {
            mediaRef.current?.setAudioInput(!audioAvailable);
            setAudioAvailable(!audioAvailable);
          }}>{audioAvailable ? (english ? "Stop audio input, keep track" : "关闭声音输入，保留音轨")
              : (english ? "Restore audio input" : "恢复声音输入")}</button>
          <button className="lr-btn" type="button" disabled={!stream || waiting || !session} onClick={() => {
            session?.setOverlayEnabled(true);
            receiveSample({ kind: "chat", text: english ? "I'm here. Save me a seat!" : "来了，给我留个位置！" });
          }}>{english ? "Receive sample on-screen chat" : "模拟收到朋友弹幕"}</button>
          {viewer && <button className="lr-btn" type="button" aria-pressed={remote} onClick={() => {
            const url = new URL(location.href);
            if (remote) url.searchParams.delete("remote"); else url.searchParams.set("remote", "1");
            history.replaceState(history.state, "", url);
            setRemote(value => !value);
          }}>{english ? "Remote-control demo" : "远控演示"}</button>}
        </div>
        {viewer && remote && <p>{english
          ? "Start the picture, then select the mouse button to try local controls. Pinch to zoom in or back out to the original size. No input leaves this preview."
          : "开启测试画面后，点击播控里的鼠标按钮试用。双指放大或缩回原始比例；操作只在此预览内模拟。"}</p>}
        {error ? <p role="alert">{error}</p> : null}
      </header> : null}
      <div className="lr-scene">
        <StageTv live={Boolean(stream)} label={english ? "Local test picture" : "本机测试画面"}
          indicator={<StatusIndicator status={waiting ? STATUS_CATALOG.joining : stream ? STATUS_CATALOG.connected : STATUS_CATALOG.idle} />}>
          <video ref={videoRef} playsInline muted={!viewer} tabIndex={0} inert={!stream} style={{ objectFit: pictureFit }}
            aria-label={english ? "Local test video" : "本机测试视频"} />
          {waiting && <StageOverlay dim waiting icon={STATUS_CATALOG.joining.icon} message={t(STATUS_CATALOG.joining.labelKey)} comic={STATUS_CATALOG.joining.comic} />}
          <RoomChatOverlay session={session} visible={Boolean(stream) && !waiting} />
          <PlaybackControls videoRef={videoRef} stream={stream} audioAvailable={audioAvailable}
            settings={{ pictureFit, setPictureFit, pictureRotation, setPictureRotation, route: viewer ? { preference: viewerRoute, onChange: setViewerRoute,
              sfuAvailable: true, sfuOnly: false, peerOnly: false, disabled: false, rejected: false } : undefined }}
            audioTrackKey={stream?.getAudioTracks().map((track) => track.id).join(",")}
            canPlay={Boolean(stream) && !waiting} theaterMode={theaterMode} onPlay={play}
            onToggleTheater={() => setTheaterMode((value) => !value)}
            overlayAction={<RoomChatToggle session={session} />}
            remoteActions={viewer && remote ? <RemoteControl channel={remoteInput} videoRef={videoRef}
              available={Boolean(stream) && !waiting} pictureFit={pictureFit} pictureRotation={pictureRotation} /> : undefined}
            onReconnect={viewer ? () => start(hasAudio) : undefined} reconnectAvailable={viewer && Boolean(stream)} />
        </StageTv>
      </div>
    </main>;
}
