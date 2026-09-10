import { useEffect, useRef, useState } from "react";
import { AppHeader } from "../components/living/Header";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { StageTv } from "../components/living/Stage";
import { useCopy } from "../ui/copy";

function testMedia(withAudio: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const paint = canvas.getContext("2d")!;
  const started = performance.now();
  let animation = 0;
  function draw(now: number) {
    const seconds = (now - started) / 1000;
    paint.fillStyle = "#172c3b";
    paint.fillRect(0, 0, 640, 360);
    paint.fillStyle = "#29475b";
    paint.fillRect(0, 260, 640, 100);
    paint.fillStyle = "#9de8bf";
    paint.beginPath();
    paint.arc(320 + Math.sin(seconds) * 190, 180, 26, 0, Math.PI * 2);
    paint.fill();
    paint.fillStyle = "#dfe8f2";
    paint.font = "24px monospace";
    paint.fillText(`${seconds.toFixed(1)} s`, 28, 44);
    animation = requestAnimationFrame(draw);
  }
  draw(started);
  const stream = canvas.captureStream(30);
  let audio: AudioContext | undefined;
  if (withAudio) {
    audio = new AudioContext();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<ReturnType<typeof testMedia> | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [theaterMode, setTheaterMode] = useState(false);
  const [error, setError] = useState("");
  const hasAudio = Boolean(stream?.getAudioTracks().length);

  function play() {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch((cause: unknown) => {
      if (video.srcObject === stream) setError(String(cause));
    });
  }

  function start(withAudio: boolean) {
    mediaRef.current?.stop();
    const media = testMedia(withAudio);
    mediaRef.current = media;
    setError("");
    setStream(media.stream);
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
      if (event.key === "Escape") setTheaterMode(false);
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
          <button className="lr-btn" type="button" disabled={!stream} onClick={() => start(!hasAudio)}>
            {hasAudio ? (english ? "Remove audio track" : "移除音轨") : (english ? "Add quiet test tone" : "加入轻音量测试音")}</button>
          <button className="lr-btn" type="button" disabled={!stream} onClick={() => start(hasAudio)}>
            {english ? "Rebind new stream" : "重新绑定新流"}</button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </header> : null}
      <div className="lr-scene">
        <StageTv live={Boolean(stream)} label={english ? "Local test picture" : "本机测试画面"}>
          <video ref={videoRef} playsInline tabIndex={0} aria-label={english ? "Local test video" : "本机测试视频"} />
          <PlaybackControls videoRef={videoRef} stream={stream}
            audioTrackKey={stream?.getAudioTracks().map((track) => track.id).join(",")}
            canPlay={Boolean(stream)} theaterMode={theaterMode} onPlay={play}
            onToggleTheater={() => setTheaterMode((value) => !value)}
            onReconnect={() => start(hasAudio)} reconnectAvailable={Boolean(stream)} />
        </StageTv>
      </div>
    </main>
  </div>;
}
