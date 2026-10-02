import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { CHAT_OVERLAY_DURATION_MS, RoomInteractionSession } from "../../lib/room-interactions";
import { Btn } from "./primitives";
import "./room-chat-overlay.css";

export function RoomChatToggle({ session, caption = false }: { session: RoomInteractionSession | null; caption?: boolean }) {
  return session ? <ConnectedToggle key={session.key} session={session} caption={caption} /> : null;
}

function ConnectedToggle({ session, caption }: { session: RoomInteractionSession; caption: boolean }) {
  const { overlayEnabled } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <span className="lr-chat-overlay-toggle"><Btn icon="danmaku"
    cap={caption ? "interaction.overlay.label" : undefined}
    title={overlayEnabled ? "interaction.overlay.hide" : "interaction.overlay.show"}
    hint={overlayEnabled ? "hint-chat-overlay-hide" : "hint-chat-overlay-show"}
    hintText={overlayEnabled ? "interaction.overlay.hideHint" : "interaction.overlay.showHint"}
    pressed={overlayEnabled} tone={overlayEnabled ? "on" : undefined}
    onClick={() => session.setOverlayEnabled(!overlayEnabled)} /></span>;
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
