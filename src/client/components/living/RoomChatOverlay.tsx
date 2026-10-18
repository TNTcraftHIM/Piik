import { useEffect, useId, useSyncExternalStore, type CSSProperties } from "react";
import { CHAT_OVERLAY_DURATION_MS, CHAT_OVERLAY_LIMITS, RoomInteractionSession } from "../../lib/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";
import "./room-chat-overlay.css";

export function RoomChatToggle({ session }: { session: RoomInteractionSession | null }) {
  return session ? <ConnectedToggle key={session.key} session={session} /> : null;
}

function ConnectedToggle({ session }: { session: RoomInteractionSession }) {
  const { overlayEnabled } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <span className="lr-chat-overlay-toggle"><Btn icon="danmaku"
    title={overlayEnabled ? "interaction.overlay.hide" : "interaction.overlay.show"}
    hint={overlayEnabled ? "hint-chat-overlay-hide" : "hint-chat-overlay-show"}
    hintText={overlayEnabled ? "interaction.overlay.hideHint" : "interaction.overlay.showHint"}
    pressed={overlayEnabled} tone={overlayEnabled ? "on" : undefined}
    onClick={() => session.setOverlayEnabled(!overlayEnabled)} /></span>;
}

export function RoomChatOverlaySettings({ session }: { session: RoomInteractionSession }) {
  const { overlayAppearance } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, vis } = useCopy();
  const id = useId();
  return <div className="lr-chat-overlay-settings">
    {(["scale", "opacity"] as const).map(property => {
      const percent = Math.round(overlayAppearance[property] * 100);
      const label = t(`interaction.overlay.${property}`);
      return <div className="lr-chat-setting" key={property}>
        <label htmlFor={`${id}-${property}`}>
          {vis ? <Glyph name={property === "scale" ? "textSize" : "opacity"} size={18} /> : label}
          <output htmlFor={`${id}-${property}`}>{percent}%</output>
        </label>
        <Tooltip kind="hint-chat-settings" text={vis ? undefined : label}>
          <input id={`${id}-${property}`} type="range" min={CHAT_OVERLAY_LIMITS[property][0] * 100}
            max={CHAT_OVERLAY_LIMITS[property][1] * 100} step={10} value={percent}
            aria-label={label} aria-valuetext={`${percent}%`}
            onChange={event => session.setOverlayAppearance({ ...overlayAppearance, [property]: Number(event.target.value) / 100 })} />
        </Tooltip>
      </div>;
    })}
  </div>;
}

export function RoomChatOverlay({ session, visible }: { session: RoomInteractionSession | null; visible: boolean }) {
  return session ? <ConnectedOverlay key={session.key} session={session} visible={visible} /> : null;
}

function ConnectedOverlay({ session, visible }: { session: RoomInteractionSession; visible: boolean }) {
  const { overlayMessages, overlayAppearance } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    const sync = () => session.setOverlayVisible(visible && !document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      session.setOverlayVisible(false);
    };
  }, [session, visible]);
  return visible ? <div className="lr-chat-overlay" aria-hidden="true"
    style={{ "--chat-scale": overlayAppearance.scale, opacity: overlayAppearance.opacity } as CSSProperties}>
    {overlayMessages.map(message => <ChatFlight key={message.id} message={message} now={session.now} />)}
  </div> : null;
}

function ChatFlight({ message, now }: {
  message: ReturnType<RoomInteractionSession["getSnapshot"]>["overlayMessages"][number]; now: () => number;
}) {
  return <span className="lr-chat-flight" data-lane={message.lane} style={{ "--chat-lane": message.lane,
    animationDuration: `${CHAT_OVERLAY_DURATION_MS}ms` } as CSSProperties} onAnimationStart={event => {
      // Mounting or returning from reduced motion uses the remaining lifetime.
      for (const animation of event.currentTarget.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === "lr-chat-flight") {
          animation.currentTime = Math.min(CHAT_OVERLAY_DURATION_MS, Math.max(0, CHAT_OVERLAY_DURATION_MS - (message.expiresAt - now())));
        }
      }
    }}>
    {message.payload.kind === "chat" && message.payload.text}
  </span>;
}
