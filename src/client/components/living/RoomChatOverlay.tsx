import { useEffect, useId, useSyncExternalStore, type CSSProperties, type ComponentProps } from "react";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { CHAT_OVERLAY_LIMITS } from "../../lib/room-preferences";
import { useCopy } from "../../ui/copy";
import { Btn, SwitchItem } from "./primitives";
import { participantColor } from "./participant-color";
import "./room-chat-overlay.css";
import { useSurfaceDocument } from "../../ui/panel-window";

type ToggleProps = { session: RoomInteractionSession | null } & Pick<ComponentProps<typeof Btn>, "size" | "quiet">;

export function RoomChatToggle({ session, ...appearance }: ToggleProps) {
  return session ? <ConnectedToggle key={session.key} session={session} {...appearance} /> : null;
}

function ConnectedToggle({ session, ...appearance }: ToggleProps & { session: RoomInteractionSession }) {
  const overlayEnabled = useSyncExternalStore(session.subscribe, () => session.getSnapshot().overlayEnabled);
  return <span className="lr-chat-overlay-toggle"><Btn icon="danmaku" {...appearance}
    title={overlayEnabled ? "interaction.overlay.hide" : "interaction.overlay.show"}
    hint={overlayEnabled ? "hint-chat-overlay-hide" : "hint-chat-overlay-show"}
    hintText={overlayEnabled ? "interaction.overlay.hideHint" : "interaction.overlay.showHint"}
    pressed={overlayEnabled} tone={overlayEnabled ? "on" : undefined}
    onClick={() => session.setOverlayEnabled(!overlayEnabled)} /></span>;
}

export function RoomChatOverlaySettings({ session }: { session: RoomInteractionSession }) {
  const overlayAppearance = useSyncExternalStore(session.subscribe, () => session.getSnapshot().overlayAppearance);
  const { t } = useCopy();
  const id = useId();
  return <div className="lr-chat-overlay-settings">
    {(["scale", "opacity", "speed"] as const).map(property => {
      const percent = Math.round(overlayAppearance[property] * 100);
      const label = t(`interaction.overlay.${property}`);
      return <div className="lr-chat-setting" key={property}>
        <label htmlFor={`${id}-${property}`}>
          {label}
          <output htmlFor={`${id}-${property}`}>{percent}%</output>
        </label>
        <input id={`${id}-${property}`} type="range" min={CHAT_OVERLAY_LIMITS[property][0] * 100}
          max={CHAT_OVERLAY_LIMITS[property][1] * 100} step={10} value={percent}
          aria-label={label} aria-valuetext={`${percent}%`}
          aria-describedby={property === "speed" ? id + "-speed-hint" : undefined}
          onChange={event => session.setOverlayAppearance({ [property]: Number(event.target.value) / 100 })} />
        {property === "speed" && <p id={id + "-speed-hint"}>{t("interaction.overlay.speedHint")}</p>}
      </div>;
    })}
    <div className="lr-chat-color-setting">

      <SwitchItem checked={overlayAppearance.colorBySender} onChange={colorBySender => session.setOverlayAppearance({ colorBySender })}
        label={t("interaction.overlay.colorBySender")} hint="hint-chat-settings" />
    </div>
    <p>{t("interaction.settingsHint")}</p>
  </div>;
}

export function RoomChatOverlay({ session, visible }: { session: RoomInteractionSession | null; visible: boolean }) {
  return session ? <ConnectedOverlay key={session.key} session={session} visible={visible} /> : null;
}

function ConnectedOverlay({ session, visible }: { session: RoomInteractionSession; visible: boolean }) {
  const overlayMessages = useSyncExternalStore(session.subscribe, () => session.getSnapshot().overlayMessages);
  const overlayAppearance = useSyncExternalStore(session.subscribe, () => session.getSnapshot().overlayAppearance);
  const ownerDocument = useSurfaceDocument();
  useEffect(() => {
    if (!ownerDocument) return;
    let release: (() => void) | undefined;
    const sync = () => {
      if (visible && !ownerDocument.hidden) release ??= session.showOverlay();
      else { release?.(); release = undefined; }
    };
    sync();
    ownerDocument.addEventListener("visibilitychange", sync);
    return () => {
      ownerDocument.removeEventListener("visibilitychange", sync);
      release?.();
    };
  }, [session, visible, ownerDocument]);
  return visible ? <div className="lr-chat-overlay" aria-hidden="true"
    style={{ "--chat-scale": overlayAppearance.scale, opacity: overlayAppearance.opacity } as CSSProperties}>
    {overlayMessages.map(message => <ChatFlight key={message.id} message={message} now={session.now} colorBySender={overlayAppearance.colorBySender} />)}
  </div> : null;
}

function ChatFlight({ message, now, colorBySender }: {
  message: ReturnType<RoomInteractionSession["getSnapshot"]>["overlayMessages"][number]; now: () => number; colorBySender: boolean;
}) {
  return <span className={`lr-chat-flight${colorBySender ? " is-colored" : ""}`} data-lane={message.lane} style={{ "--chat-lane": message.lane,
    "--chat-person-color": colorBySender ? participantColor(message.sender.peerId) : undefined,
    animationDuration: `${message.durationMs}ms` } as CSSProperties} onAnimationStart={event => {
      // Mounting or returning from reduced motion uses the remaining lifetime.
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      for (const animation of event.currentTarget.getAnimations()) {
        if (ownerWindow && animation instanceof ownerWindow.CSSAnimation && animation.animationName === "lr-chat-flight") {
          animation.currentTime = Math.min(message.durationMs, Math.max(0, message.durationMs - (message.expiresAt - now())));
        }
      }
    }}>
    {message.payload.kind === "chat" && message.payload.text}
  </span>;
}
