import { useEffect, useRef, useState } from "react";
import type { VideoFit, VideoRotation } from "../media/video-geometry";
import { AppHeader } from "../components/living/Header";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { StageOverlay, StageTv } from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { STATUS_CATALOG } from "../ui/media-status";
import { useCopy } from "../ui/copy";

export function testMedia(withAudio: boolean, portrait: boolean) {
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
  const { lang, t } = useCopy();
  const english = lang === "en";
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<ReturnType<typeof testMedia> | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [theaterMode, setTheaterMode] = useState(false);
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
    if (!theaterMode) return;
    function exit(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) setTheaterMode(false);
    }
    document.body.classList.add("lr-theater-open");
    window.addEventListener("keydown", exit);
    return () => {
      document.body.classList.remove("lr-theater-open");
      window.removeEventListener("keydown", exit);
    };
  }, [theaterMode]);

  return <div className="lr-app">
    <AppHeader homeHref="/__playback-preview" />
    <main className={`lr-room${theaterMode ? " is-theater" : ""}`}>
      {!theaterMode ? <header style={{ margin: "20px 0" }}>
        <h1>{english ? "Playback controls" : "播放控件预览"}</h1>
        <p>{english ? "Local test video only. Sound starts only when requested; no room or capture is opened."
          : "仅本机测试画面；点击才加入轻音量测试音，不开房间、不采集屏幕。"}</p>
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
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </header> : null}
      <div className="lr-scene">
        <StageTv live={Boolean(stream)} label={english ? "Local test picture" : "本机测试画面"}
          indicator={<StatusIndicator status={waiting ? STATUS_CATALOG.joining : stream ? STATUS_CATALOG.connected : STATUS_CATALOG.idle} />}>
          <video ref={videoRef} playsInline tabIndex={0} inert={!stream} style={{ objectFit: pictureFit }}
            aria-label={english ? "Local test video" : "本机测试视频"} />
          {waiting && <StageOverlay dim waiting icon={STATUS_CATALOG.joining.icon} message={t(STATUS_CATALOG.joining.labelKey)} comic={STATUS_CATALOG.joining.comic} />}
          <PlaybackControls videoRef={videoRef} stream={stream} audioAvailable={audioAvailable}
            settings={{ pictureFit, setPictureFit, pictureRotation, setPictureRotation, route: { preference: viewerRoute, onChange: setViewerRoute,
              sfuAvailable: true, sfuOnly: false, peerOnly: false, disabled: false, rejected: false } }}
            audioTrackKey={stream?.getAudioTracks().map((track) => track.id).join(",")}
            canPlay={Boolean(stream) && !waiting} theaterMode={theaterMode} onPlay={play}
            onToggleTheater={() => setTheaterMode((value) => !value)}
            onReconnect={() => start(hasAudio)} reconnectAvailable={Boolean(stream)} />
        </StageTv>
      </div>
    </main>
  </div>;
}
