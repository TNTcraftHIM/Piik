import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HostRemoteControl } from "../components/living/HostRemoteControl";
import { RemoteControl } from "../components/living/RemoteControl";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { RemoteTouchSettings } from "../components/living/PlaybackSettings";
import { StageTv } from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { RemoteKeyboard } from "../components/living/RemoteKeyboard";
import { RemoteMouse, placeRemotePointer, remotePointerRoom } from "../components/living/RemoteMouse";
import { Couch } from "../components/living/Couch";
import { STATUS_CATALOG } from "../ui/media-status";
import { Btn } from "../components/living/primitives";
import type { RemoteControlRequest } from "../native/wire";
import type { RemoteInputEvent } from "../remote-control/input-session";
import { picturePoint, pictureRect, rotatePicturePoint, videoRotation } from "../media/video-geometry";
import { RemoteTouchpad } from "../remote-control/touchpad";
import { RemoteViewport } from "../remote-control/viewport";
import type { RoomPreferences } from "../lib/room-preferences";
import type { RemoteControlMode, RemoteInputPlatform } from "../remote-control/protocol";
import { useCopy } from "../ui/copy";
import { testMedia } from "./PlaybackPreviewPage";
import { PreviewInput } from "./preview-input";

const participants = [
  { peerId: "preview-player-one", name: "Player 1" },
  { peerId: "preview-player-two", name: "Player 2" },
  { peerId: "preview-gamepad", name: "Player 3" },
];

export function RemoteControlsPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [platform, setPlatform] = useState<RemoteInputPlatform>("windows");
  const [mode, setMode] = useState<RemoteControlMode>("off");
  const [simultaneous, setSimultaneous] = useState(false);
  const [requests, setRequests] = useState<(RemoteControlRequest & { name: string })[]>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [lastInput, setLastInput] = useState("");
  const mouseVideo = useRef<HTMLVideoElement>(null);
  const mouseLayer = useRef<HTMLDivElement>(null);
  const mouseSurface = useRef<HTMLDivElement>(null);
  const [pointer, setPointer] = useState<RemoteTouchpad | null>(null);
  const [touchMode, setTouchMode] = useState<RoomPreferences["remoteTouchMode"]>("direct");
  const [releaseKey, setReleaseKey] = useState(10);
  const [stopKey, setStopKey] = useState(10);
  const shortcut = useCallback(async (key?: number) => {
    if (key !== undefined) setStopKey(key);
    return { key: key ?? stopKey, available: true };
  }, [stopKey]);
  const input = useCallback((event: RemoteInputEvent) => setLastInput(JSON.stringify(event)), []);
  const placePointer = useCallback((position: { x: number; y: number }) => {
    const layer = mouseLayer.current, video = mouseVideo.current;
    if (!layer || !video) return;
    const picture = pictureRect(video);
    if (!picture) return;
    const rect = layer.getBoundingClientRect();
    const point = rotatePicturePoint(position, videoRotation(video));
    placeRemotePointer(layer, picture.left - rect.left + point.x * picture.width, picture.top - rect.top + point.y * picture.height);
  }, []);
  useEffect(() => {
    const element = mouseVideo.current!;
    const surface = mouseSurface.current!;
    const view = new RemoteViewport(element, surface, () => placePointer(current.position));
    const current = new RemoteTouchpad(() => {
      const rect = pictureRect(element);
      return rect ? { ...rect, rotation: videoRotation(element) } : null;
    }, input, deltaY => setLastInput(JSON.stringify({ type: "wheel", deltaY })), position => {
      view.follow(position, remotePointerRoom(mouseLayer.current));
      placePointer(position);
    }, view);
    setPointer(current);
    const sample = testMedia(false, false);
    element.srcObject = sample.stream;
    void element.play().catch(() => {});
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      current.wheel(event.deltaY);
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    const position = () => { view.refresh(); current.refresh(); };
    const resize = new ResizeObserver(position);
    resize.observe(surface);
    element.addEventListener("resize", position);
    position();
    return () => {
      resize.disconnect();
      element.removeEventListener("resize", position);
      surface.removeEventListener("wheel", wheel);
      current.reset(); view.reset(); setPointer(null);
      element.srcObject = null;
      sample.stop();
    };
  }, [input, placePointer]);
  const closeKeyboard = () => {
    setKeyboardOpen(false);
    document.getElementById("preview-remote-keyboard-toggle")?.focus();
  };

  return <><PermissionRequestPreview /><section id="remote-control-preview" className="cp-section">
    <header className="cp-section-head"><div>
      <h2>{t("remote.inputTools")}</h2>
      <p>{en ? "Expand the mini mouse and drag its lower half to move the pointer. Hold and move L or R to drag, or hold a button with one finger and move the lower half with another. Pinch or pan the picture with two fingers to adjust the local view. Tap the wheel to middle-click, swipe to scroll, or hold to drag. Try direct touch or the compact trackpad below. Input stays in the local log."
        : "展开迷你鼠标，拖动下半部移动光标。按住 L 或 R 后移动即可拖拽，也可用一指按住按钮、另一指拖动下半部。在画面上双指缩放或平移可调整本地视图。滚轮可轻点中击、滑动滚动、长按后拖动。下方可切换直接触摸或光标触控板，输入仅记录在本地。"}</p>
    </div></header>
    <div className="cp-stage" style={{ maxWidth: 480 }}>
      <StageTv live label={en ? "Local mouse example" : "本地鼠标示例"}>
        <video ref={mouseVideo} muted playsInline style={{ objectFit: "cover" }}
          aria-label={en ? "Local sample picture" : "本地示例画面"} />
        <div ref={mouseSurface} className="lr-remote-input-surface" role="application" aria-label={t("remote.surface")} tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
            pointer?.down(event.pointerId, event.clientX, event.clientY,
              mouseVideo.current && picturePoint(mouseVideo.current, event.clientX, event.clientY));
          }}
          onPointerMove={event => pointer?.move(event.pointerId, event.clientX, event.clientY)}
          onPointerUp={event => pointer?.up(event.pointerId)}
          onPointerCancel={event => pointer?.cancel(event.pointerId)}
          onLostPointerCapture={event => pointer?.cancel(event.pointerId)}
          onContextMenu={event => event.preventDefault()}>
          {pointer && <RemoteMouse pointer={pointer} positionRef={mouseLayer} touchMode={touchMode}
            pointAt={(x, y) => mouseVideo.current && picturePoint(mouseVideo.current, x, y)} />}
        </div>
      </StageTv>
    </div>
    <div className="lr-viewer-settings is-single" style={{ maxWidth: 480 }}>
      <RemoteTouchSettings mode={touchMode} onChange={setTouchMode} />
    </div>
    <div className="cp-tools">
      <label className="lr-input"><span>{en ? "Host platform" : "房主平台"}</span>
        <select value={platform} onChange={event => setPlatform(event.target.value as RemoteInputPlatform)}>
          <option value="windows">Windows</option><option value="darwin">macOS</option><option value="linux">Linux</option>
        </select>
      </label>
      <Btn id="preview-remote-keyboard-toggle" icon="keyboard" title="remote.keyboard" cap="remote.keyboard" hint="hint-remote-keyboard"
        expanded={keyboardOpen} controls="preview-remote-keyboard" onClick={() => setKeyboardOpen(value => !value)} />
    </div>
    <div id="preview-remote-keyboard" className="cp-keyboard" hidden={!keyboardOpen}>
      {keyboardOpen && <RemoteKeyboard key={platform} platform={platform} touch input={input} close={closeKeyboard}
        allowText={requests.filter(request => request.state !== "pending").length < 2}
        releaseKey={releaseKey} onReleaseKeyChange={setReleaseKey} />}
    </div>
    <p className="cp-input-output"><span>{en ? "Latest input" : "最近一次输入"}</span>
      <output>{lastInput || (en ? "Touch the picture directly, or tap the mini mouse for pointer controls." : "直接触摸画面，或轻点迷你鼠标展开光标控制。")}</output>
    </p>
    <div className="cp-tools">
      <HostRemoteControl mode={mode} platform={platform} requests={requests}
        gamepad={platform !== "darwin"}
        simultaneous={simultaneous}
        onSimultaneous={async enabled => { setSimultaneous(enabled); setRequests([]); }}
        onShortcut={platform === "linux" ? undefined : shortcut}
        onPolicy={async value => { setMode(value); setRequests([]); }}
        onDecide={async (id, allow) => setRequests(current => allow
          ? current.map(request => request.id === id ? { ...request, state: "active" } : request)
          : current.filter(request => request.id !== id))} />
      <button type="button" className="lr-btn" onClick={() => {
        setMode("ask");
        setRequests([{ id: "preview-request", ...participants[0]!, state: "pending" }]);
      }}>{en ? "Receive a sample request" : "模拟收到控制请求"}</button>
      <button type="button" className="lr-btn" onClick={() => {
        setMode("ask");
        setSimultaneous(true);
        setRequests([
          { id: "preview-player-one", peerId: "preview-player-one", state: "active", name: "Player 1" },
          { id: "preview-player-two", peerId: "preview-player-two", state: "active", name: "Player 2" },
          { id: "preview-gamepad", peerId: "preview-gamepad", state: "pending", name: "Player 3" },
        ]);
      }}>{en ? "Simulate multiple controllers" : "模拟多人控制"}</button>
    </div>
    <Couch view="host" host={{ key: "preview-host", name: "Silip", you: true }}
      entries={participants.map(person => {
        const grant = requests.find(request => request.peerId === person.peerId && request.state !== "pending");
        return { key: person.peerId, name: person.name, status: STATUS_CATALOG.connected, selectable: false,
          collaboration: Boolean(grant) };
      })} />
  </section></>;
}

function PermissionRequestPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [channel] = useState(() => new PreviewInput());
  const state = useSyncExternalStore(channel.subscribe, channel.getSnapshot);
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [theater, setTheater] = useTheaterMode();
  useEffect(() => {
    const sample = testMedia(false, false);
    const element = video.current!;
    element.srcObject = sample.stream;
    setStream(sample.stream);
    void element.play().catch(() => {});
    return () => { element.srcObject = null; sample.stop(); };
  }, []);
  const hasRequest = state.state === "pending" || state.state === "active" || state.state === "suspended";
  return <section id="remote-permission-preview" className="cp-section">
    <header className="cp-section-head"><div>
      <h2>{en ? "Request remote control" : "权限申请"}</h2>
      <p>{en ? "Use the mouse button in the playback bar, then handle the request in the Host's remote-control window. The local sample picture does not control your computer."
        : "点击播控上的鼠标按钮，再到房主的远控浮窗处理请求。这里是本地示例画面，不会操作电脑。"}</p>
    </div></header>
    <div className="cp-permission-flow">
      <div className={theater ? "lr-room is-theater" : "cp-permission-viewer"}>
        <div className="lr-scene">
          <StageTv live={Boolean(stream)} label={en ? "Viewer picture" : "观众画面"}
            indicator={<StatusIndicator status={stream ? STATUS_CATALOG.connected : STATUS_CATALOG.joining} />}>
            <video ref={video} muted playsInline aria-label={en ? "Local sample picture" : "本地示例画面"} />
            <PlaybackControls videoRef={video} stream={stream} canPlay={Boolean(stream)} theaterMode={theater}
              onPlay={() => { void video.current?.play().catch(() => {}); }} onToggleTheater={() => setTheater(value => !value)}
              onReconnect={() => channel.reset()} reconnectAvailable={false}
              remoteActions={<RemoteControl channel={channel} videoRef={video} available />} />
          </StageTv>
        </div>
      </div>
      <aside className="cp-permission-host" aria-label={en ? "Host" : "房主侧"}>
        <h3>{en ? "Host" : "房主侧"}</h3>
        <HostRemoteControl mode={state.mode} platform="windows"
          requests={hasRequest ? [{ id: "preview-request", name: "Player 1", peerId: "preview-player-one", state: state.state as "pending" | "active" | "suspended" }] : []}
          onPolicy={async (mode, password) => channel.policy(mode, password)} onDecide={async (_id, allow) => channel.decide(allow)} />
        <p>{hasRequest ? t(state.state === "pending" ? "remote.waiting" : "remote.controlling") : en ? "Waiting for a request." : "等待权限申请。"}</p>
      </aside>
    </div>
    <div className="cp-tools"><button type="button" className="lr-btn is-compact" onClick={() => channel.policy("ask")}>
      {en ? "Reset example" : "重置示例"}</button>
      <button type="button" className="lr-btn is-compact" disabled={state.state !== "active"} onClick={() => channel.failInput()}>
        {en ? "Simulate an input failure" : "模拟单次操作失败"}</button>
      <span className="cp-permission-caption">{en ? "Hover the picture to reveal its normal playback controls." : "鼠标移入画面，即可呼出正式播控。"}</span>
    </div>
  </section>;
}
