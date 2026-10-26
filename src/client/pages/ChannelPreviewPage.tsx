import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "../components/living/Header";
import { PawnSvg } from "../components/living/Pawn";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { z } from "zod";
import "./channel-preview.css";

const channels = [
  {
    id: "living",
    zh: "客厅",
    en: "Living room",
    noteZh: "想说什么，都可以在这里开始。",
    noteEn: "A little room for whatever comes next.",
    icon: "couch",
  },
  {
    id: "studio",
    zh: "一起做点什么",
    en: "The studio",
    noteZh: "打开一个想法，一起把它做出来。",
    noteEn: "Bring an idea. Make something together.",
    icon: "tv",
  },
  {
    id: "quiet",
    zh: "安静待着",
    en: "Quiet corner",
    noteZh: "各忙各的，也算在一起。",
    noteEn: "Doing your own thing, in good company.",
    icon: "headphones",
  },
] as const;
type ChannelId = (typeof channels)[number]["id"];
type Message = { id: string; text: string; time: string; sender: string };
type Capture = { channel: ChannelId; stream: MediaStream };
const messageSchema = z.object({
  id: z.string().uuid(),
  sender: z.string().uuid(),
  text: z.string().refine((value) => [...value].length <= 2000),
  time: z.string().max(40),
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    identity: z.string().uuid(),
    history: z.object({
      living: z.array(messageSchema).max(100),
      studio: z.array(messageSchema).max(100),
      quiet: z.array(messageSchema).max(100),
    }),
  }),
  z.object({
    type: z.literal("message"),
    channel: z.enum(["living", "studio", "quiet"]),
    message: messageSchema,
  }),
]);

export function ChannelPreviewPage() {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => (zh ? cn : en);
  const [selected, setSelected] = useState<ChannelId>("living");
  const [messages, setMessages] = useState<Record<ChannelId, Message[]>>({
    living: [],
    studio: [],
    quiet: [],
  });
  const [drafts, setDrafts] = useState<Record<ChannelId, string>>({
    living: "",
    studio: "",
    quiet: "",
  });
  const [voice, setVoice] = useState<Capture | null>(null);
  const [screen, setScreen] = useState<Capture | null>(null);
  const [pending, setPending] = useState<"voice" | "screen" | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const resources = useRef({
    voice: null as Capture | null,
    screen: null as Capture | null,
    mounted: true,
  });
  const video = useRef<HTMLVideoElement>(null);
  const [identity, setIdentity] = useState("");
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const channel = channels.find((item) => item.id === selected)!;
  const name = (id: ChannelId) => {
    const item = channels.find((item) => item.id === id)!;
    return zh ? item.zh : item.en;
  };
  useEffect(() => {
    const owner = resources.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.voice?.stream.getTracks().forEach((track) => track.stop());
      owner.screen?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    const connection = new WebSocket("ws://127.0.0.1:8791/channels");
    socket.current = connection;
    setConnected(false);
    connection.onclose = () => {
      if (socket.current === connection) setConnected(false);
    };
    connection.onerror = () => {
      if (socket.current === connection) setConnected(false);
    };
    connection.onmessage = (event) => {
      if (socket.current !== connection) return;
      let input: unknown;
      try {
        input = JSON.parse(event.data);
      } catch {
        connection.close();
        return;
      }
      const parsed = eventSchema.safeParse(input);
      if (!parsed.success) {
        connection.close();
        return;
      }
      const payload = parsed.data;
      if (payload.type === "welcome") {
        setConnected(true);
        setIdentity(payload.identity);
        setMessages(payload.history);
      } else if (payload.type === "message") {
        setMessages((previous) => ({
          ...previous,
          [payload.channel]: [
            ...previous[payload.channel],
            payload.message,
          ].slice(-100),
        }));
      }
    };
    return () => {
      connection.close();
      socket.current = null;
    };
  }, [retry]);
  useEffect(() => {
    if (video.current)
      video.current.srcObject =
        screen?.channel === selected ? screen.stream : null;
  }, [screen, selected]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, selected]);

  function stop(kind: "voice" | "screen") {
    resources.current[kind]?.stream
      .getTracks()
      .forEach((track) => track.stop());
    resources.current[kind] = null;
    if (kind === "voice") {
      setVoice(null);
      setMuted(false);
    } else setScreen(null);
  }
  async function capture(kind: "voice" | "screen") {
    if (pending) return;
    if (kind === "voice" && resources.current.voice) {
      const moved = {
        channel: selected,
        stream: resources.current.voice.stream,
      };
      resources.current.voice = moved;
      setVoice(moved);
      setError("");
      return;
    }
    setPending(kind);
    setError("");
    try {
      const stream =
        kind === "voice"
          ? await navigator.mediaDevices.getUserMedia({ audio: true })
          : await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true,
            });
      if (!resources.current.mounted) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stop(kind);
      const next = { channel: selected, stream };
      resources.current[kind] = next;
      if (kind === "voice") setVoice(next);
      else setScreen(next);
      const primaryTrack =
        kind === "voice"
          ? stream.getAudioTracks()[0]
          : stream.getVideoTracks()[0];
      primaryTrack?.addEventListener(
        "ended",
        () => {
          if (resources.current[kind]?.stream === stream) stop(kind);
        },
        { once: true },
      );
    } catch (cause) {
      if (resources.current.mounted)
        setError(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? copy(
                "已取消或未允许采集。可以随时再试。",
                "Capture was cancelled or permission was declined. You can try again.",
              )
            : copy(
                "未能打开设备，请检查浏览器权限。",
                "Could not open the device. Check browser permissions.",
              ),
        );
    } finally {
      if (resources.current.mounted) setPending(null);
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!drafts[selected].trim()) return;
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(
      JSON.stringify({ channel: selected, text: drafts[selected].trim() }),
    );
    setDrafts((previous) => ({ ...previous, [selected]: "" }));
  }
  return (
    <div className="lr-app cp-app">
      <AppHeader />
      <main className="cp-shell">
        <aside className="cp-sidebar" aria-label={copy("频道", "Channels")}>
          <div className="cp-home">
            <span className="cp-eyebrow">PIIK / 3.0</span>
            <h1>{copy("朋友的地方", "A place for friends")}</h1>
            <p>
              {copy(
                "小小的空间，随时回来。",
                "Your little place to come back to.",
              )}
            </p>
          </div>
          <div className="cp-section-label">
            {copy("我们的频道", "OUR CHANNELS")}
          </div>
          <nav className="cp-channels">
            {channels.map((item) => (
              <button
                key={item.id}
                className={`cp-channel${selected === item.id ? " is-selected" : ""}`}
                aria-current={selected === item.id ? "page" : undefined}
                onClick={() => {
                  setSelected(item.id);
                  setError("");
                }}
              >
                <Glyph name={item.icon} size={22} />
                <span>
                  <strong>{zh ? item.zh : item.en}</strong>
                  {voice?.channel === item.id ? (
                    <small>
                      {copy("你的麦克风在这里", "Your microphone is here")}
                    </small>
                  ) : null}
                </span>
                {messages[item.id].length ? (
                  <span className="cp-count">{messages[item.id].length}</span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="cp-sidebar-bottom">
            <PawnSvg
              color="var(--you)"
              voice={voice ? { microphone: !muted } : undefined}
            />
            <div>
              <strong>{copy("你", "You")}</strong>
              <small>{copy("本机体验", "Local preview")}</small>
            </div>
          </div>
        </aside>
        <section className="cp-room" aria-label={name(selected)}>
          <header className="cp-room-heading">
            <div>
              <span className="cp-eyebrow">
                {copy(
                  "留在一起，不必一直分享",
                  "TOGETHER, EVEN BETWEEN SHARES",
                )}
              </span>
              <h2>{name(selected)}</h2>
              <p>{zh ? channel.noteZh : channel.noteEn}</p>
            </div>
            <span className="cp-preview-badge">
              {copy("交互原型", "Interactive prototype")}
            </span>
          </header>
          <div className="cp-content">
            <section
              className="cp-conversation"
              aria-label={copy("频道聊天", "Channel chat")}
            >
              <header>
                <Glyph name="chat" size={20} />
                <h3>{copy("说点什么", "The conversation")}</h3>
                <span role="status">
                  {connected ? (
                    copy("已连接", "Connected")
                  ) : (
                    <button
                      className="cp-reconnect"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      {copy("重新连接", "Reconnect")}
                    </button>
                  )}
                </span>
              </header>
              {screen?.channel === selected ? (
                <div className="cp-stage">
                  <video
                    ref={video}
                    autoPlay
                    playsInline
                    muted
                    aria-label={copy("本机屏幕预览", "Local screen preview")}
                  />
                  <span className="cp-stage-label">
                    {copy("仅本机预览", "Local preview only")}
                  </span>
                </div>
              ) : null}
              <div
                className="cp-message-log"
                ref={log}
                role="log"
                aria-label={copy("消息", "Messages")}
              >
                <div className="cp-chat-welcome">
                  <Glyph name={channel.icon} size={32} />
                  <h3>
                    {copy("这里是", "Welcome to ")}
                    {name(selected)}
                  </h3>
                  <p>
                    {copy(
                      "在另一个标签页打开这里，互相打个招呼。每个频道都有自己的对话。",
                      "Open this page in another tab and say hello. Every channel has its own conversation.",
                    )}
                  </p>
                </div>
                {messages[selected].map((message) => (
                  <article className="cp-message" key={message.id}>
                    <PawnSvg
                      color={
                        message.sender === identity
                          ? "var(--you)"
                          : "var(--pawn-1)"
                      }
                    />
                    <div>
                      <div className="cp-message-meta">
                        <strong>
                          {message.sender === identity
                            ? copy("你", "You")
                            : copy("朋友", "Friend")}
                        </strong>
                        <time>{message.time}</time>
                      </div>
                      {message.text ? <p>{message.text}</p> : null}
                    </div>
                  </article>
                ))}
              </div>
              <form className="cp-composer" onSubmit={send}>
                <textarea
                  maxLength={2000}
                  aria-label={copy("消息内容", "Message")}
                  placeholder={copy(
                    `给${name(selected)}留句话…`,
                    `Message ${name(selected)}…`,
                  )}
                  value={drafts[selected]}
                  onChange={(event) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [selected]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="cp-compose-actions">
                  <small>{copy("Enter 发送", "Enter to send")}</small>
                  <button
                    className="lr-btn is-dense is-primary"
                    type="submit"
                    disabled={!connected || !drafts[selected].trim()}
                    aria-label={copy("发送", "Send")}
                  >
                    <Glyph name="send" size={18} />
                  </button>
                </div>
              </form>
              <p className="cp-retention">
                {copy(
                  "聊天经本机 Rust 服务同步，重启服务即清空。",
                  "Chat syncs through the local Rust service. Server restart clears history.",
                )}
              </p>
            </section>
            <section
              className="cp-presence"
              aria-label={copy("语音和画面", "Voice and screen")}
            >
              <div className="cp-media-actions">
                <button
                  className={`lr-btn is-compact${screen?.channel === selected ? " is-danger" : ""}`}
                  disabled={
                    !!pending || (!!screen && screen.channel !== selected)
                  }
                  onClick={() =>
                    screen?.channel === selected
                      ? stop("screen")
                      : void capture("screen")
                  }
                >
                  <Glyph name="tv" size={19} />
                  <span>
                    {screen?.channel === selected
                      ? copy("停止预览", "Stop preview")
                      : copy("预览屏幕", "Preview screen")}
                  </span>
                </button>
                <small>
                  {copy(
                    "系统选择器会让你选择画面",
                    "Choose a surface in the system picker",
                  )}
                </small>
              </div>
              <div className="cp-voice-card">
                <div className="cp-voice-title">
                  <Glyph name="headphones" size={22} />
                  <h3>{copy("本机麦克风", "Local microphone")}</h3>
                </div>
                <div className="cp-seat">
                  <PawnSvg
                    color={
                      voice?.channel === selected ? "var(--you)" : "var(--idle)"
                    }
                    voice={
                      voice?.channel === selected
                        ? { microphone: !muted }
                        : undefined
                    }
                  />
                  <p>
                    {voice?.channel === selected
                      ? muted
                        ? copy("你的麦克风已静音", "Your microphone is muted")
                        : copy("你的麦克风已打开", "Your microphone is open")
                      : copy(
                          "试试麦克风，感受频道切换。",
                          "Try your microphone while switching channels.",
                        )}
                  </p>
                </div>
                {voice?.channel === selected ? (
                  <div className="cp-voice-actions">
                    <button
                      className="lr-btn is-dense"
                      aria-pressed={muted}
                      onClick={() => {
                        voice.stream.getAudioTracks().forEach((track) => {
                          track.enabled = muted;
                        });
                        setMuted(!muted);
                      }}
                    >
                      <Glyph
                        name={muted ? "microphoneOff" : "microphone"}
                        size={18}
                      />
                      {muted
                        ? copy("取消静音", "Unmute")
                        : copy("静音", "Mute")}
                    </button>
                    <button
                      className="lr-btn is-dense is-quiet"
                      onClick={() => stop("voice")}
                    >
                      {copy("离开语音", "Leave voice")}
                    </button>
                  </div>
                ) : (
                  <button
                    className="lr-btn is-compact"
                    disabled={!!pending}
                    onClick={() => void capture("voice")}
                  >
                    <Glyph name="microphone" size={18} />
                    {voice
                      ? copy("将麦克风移到这里", "Move microphone here")
                      : copy("试试麦克风", "Try microphone")}
                  </button>
                )}
                <small>
                  {copy(
                    "仅采集本机声音，不向其他设备发送。",
                    "Captures locally. Audio is not sent to other devices.",
                  )}
                </small>
              </div>
              {voice && voice.channel !== selected ? (
                <p className="cp-context">
                  {copy("麦克风仍在：", "Microphone remains in: ")}
                  {name(voice.channel)}
                </p>
              ) : null}
              {screen && screen.channel !== selected ? (
                <p className="cp-context">
                  <button onClick={() => setSelected(screen.channel)}>
                    {copy("回到屏幕所在频道：", "Return to your screen: ")}
                    {name(screen.channel)}
                  </button>
                </p>
              ) : null}
              {error ? (
                <p className="cp-error" role="alert">
                  {error}
                </p>
              ) : null}
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
