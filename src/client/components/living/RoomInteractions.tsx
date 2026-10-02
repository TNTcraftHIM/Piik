import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { normalizeChatText, MAX_CHAT_CODE_POINTS, REACTION_IDS, isThrow } from "../../../shared/room-interactions";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, SwitchItem } from "./primitives";
import { participantColor } from "./participant-color";
import { FloatingPanel } from "./FloatingPanel";
import { PawnSvg } from "./Pawn";
import { Couch, type CouchProps } from "./Couch";
import { RoomReaction, ReactionIcon } from "./RoomReaction";
import { RoomChatToggle } from "./RoomChatOverlay";
import { RoomChatSettings } from "./RoomChatSettings";
import "./room-interactions.css";

interface Participant { peerId: string; displayName: string }
type Props = CouchProps & { session: RoomInteractionSession | null };

export function RoomInteractions(props: Props) {
  return props.session ? <ConnectedRoomInteractions key={props.session.key} {...props} session={props.session} /> : <Couch {...props} />;
}

type ConnectedProps = Props & { session: RoomInteractionSession };
function ConnectedRoomInteractions(props: ConnectedProps) {
  const state = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  return <InteractionPanel {...props} state={state} />;
}

function InteractionPanel({ session, state, ...couch }: ConnectedProps & {
  state: ReturnType<RoomInteractionSession["getSnapshot"]>;
}) {
  const { t, vis } = useCopy();
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [effects, setEffects] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [following, setFollowing] = useState(true);
  const area = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const id = useId();
  const menuId = `${id}-person`;
  const participants: Participant[] = [
    ...(couch.host ? [{ peerId: couch.host.key, displayName: couch.host.name }] : []),
    ...couch.entries.map(entry => ({ peerId: entry.key, displayName: entry.name })),
  ];
  const latest = state.messages.at(-1)?.id ?? null;
  const unseenIndex = state.messages.findIndex(message => message.id === lastSeen);
  const unread = latest === lastSeen ? 0 : state.messages.length - unseenIndex - 1;
  const canSend = state.ready && !state.pending && !state.coolingDown;
  const person = participants.find(person => person.peerId === target);
  const rosterKey = participants.map(person => person.peerId).join(",");
  const inspect = target === couch.host?.key && couch.host.onSelect ? () => { if (!couch.host?.selected) couch.host?.onSelect?.(); }
    : couch.entries.some(entry => entry.key === target && entry.selectable !== false) && couch.onSelect
      ? () => { if (target !== couch.selectedKey) couch.onSelect?.(target!); } : undefined;

  useEffect(() => {
    const confirmed = state.confirmed;
    if (confirmed?.payload.kind === "chat") {
      const text = confirmed.payload.text;
      setDraft(current => normalizeChatText(current) === text ? "" : current);
    }
  }, [state.confirmed]);
  useLayoutEffect(() => {
    const popup = document.getElementById(menuId);
    if (!popup) return;
    if (person && anchor.current?.isConnected) popup.showPopover({ source: anchor.current });
    else popup.hidePopover();
  }, [target, rosterKey, menuId]);

  function openReactions(key: string, trigger: HTMLButtonElement) {
    const popup = document.getElementById(menuId);
    if (target === key && popup?.matches(":popover-open")) { popup.hidePopover(); return; }
    anchor.current = trigger;
    setTarget(key);
  }
  useEffect(() => {
    if (!chatOpen || !log.current) return;
    let active = true;
    let inView = false;
    const sync = () => { if (active) setVisible(inView && document.visibilityState === "visible"); };
    const observer = new IntersectionObserver(entries => {
      const entry = entries.at(-1);
      inView = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
      sync();
    });
    observer.observe(log.current);
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      setVisible(false);
    };
  }, [chatOpen]);
  useEffect(() => {
    if (!chatOpen || !visible || !following || document.visibilityState !== "visible" ||
      !log.current?.getClientRects().length) return;
    setLastSeen(latest);
    log.current.scrollTop = log.current.scrollHeight;
  }, [latest, chatOpen, visible, following]);

  return <div className="lr-room-interactions">
    <div className="visually-hidden" role="log" aria-label={t("interaction.reactions")}
      aria-live="polite" aria-relevant="additions">
      {state.reactions.map(({ id, sender, payload }) => payload.kind === "reaction" && <p key={id}>
        {t(payload.targetPeerId ? "interaction.receivedReaction" : "interaction.expressedReaction", {
          sender: sender.displayName,
          reaction: t(`interaction.reaction.${payload.reaction}`),
          target: participants.find(person => person.peerId === payload.targetPeerId)?.displayName ?? t("interaction.participant"),
        })}
      </p>)}
    </div>
    <FloatingPanel id={id} trigger={`${id}-toggle`} icon="chat" className="lr-interaction-panel"
      title={t(settingsOpen ? "interaction.settings" : "interaction.title")} onOpenChange={setChatOpen}>
      {settingsOpen && <RoomChatSettings session={session} />}
      <div className="lr-chat-history" hidden={settingsOpen}>
      <div className="lr-chat-log" role="log" aria-label={t("interaction.title")} aria-live="polite" aria-relevant="additions" tabIndex={0} ref={log}
        onScroll={event => { const node = event.currentTarget; setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 40); }}>
        {state.messages.length === 0 ? <div className="lr-chat-empty">
          <span className="lr-chat-welcome" aria-hidden="true">{participants.slice(0, 2).map(person =>
            <PawnSvg key={person.peerId} identity={person.peerId} color={participantColor(person.peerId)} host={person.peerId === couch.host?.key} />)}
            <Glyph name="chat" size={24} /></span><p>{vis ? "···" : t("interaction.empty")}</p>
        </div> : state.messages.map((message, index) => {
          const previous = state.messages[index - 1];
          const continuation = previous?.sender.peerId === message.sender.peerId && previous.sender.displayName === message.sender.displayName;
          return <div key={message.id} className={`lr-chat-message${message.isSelf ? " is-self" : ""}${continuation ? " is-continuation" : ""}`}>
            {!continuation && <span className="lr-chat-avatar" aria-hidden="true"><PawnSvg
              color={participantColor(message.sender.peerId)} host={message.sender.role === "host"} /></span>}
            <div className="lr-chat-bubble">
              <span className={continuation ? "visually-hidden" : "lr-chat-author"}>{message.sender.displayName}
                {message.sender.role === "host" && <span className="visually-hidden"> · {t("common.host")}</span>}</span>
              <p>{message.payload.kind === "chat" && message.payload.text}</p>
            </div>
          </div>;
        })}
      </div>
      {!following && state.messages.length > 0 && <button type="button" className="lr-chat-latest" onClick={() => {
        setFollowing(true); log.current?.focus({ preventScroll: true });
      }}><Glyph name="arrowDown" size={15} /><span className={vis ? "visually-hidden" : undefined}>
        {unread ? t("interaction.unread", { count: String(unread) }) : t("interaction.latest")}</span></button>}
      </div>
      <form className="lr-chat-compose" hidden={settingsOpen} onSubmit={event => {
        event.preventDefault();
        const text = normalizeChatText(draft);
        if (text && canSend) { setFollowing(true); session.send({ kind: "chat", text }); }
      }}>
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={MAX_CHAT_CODE_POINTS * 2}
          aria-label={t("interaction.placeholder")} placeholder={vis ? "···" : t("interaction.placeholder")}
          autoComplete="off"
          onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
        <Btn type="submit" icon="send" title="interaction.send" hint="hint-chat-send" tone="primary" busy={state.pending?.payload.kind === "chat"}
          disabled={!canSend || !normalizeChatText(draft)} />
      </form>
      <footer className="lr-chat-footer">
      <div className="lr-chat-actions">
      <RoomChatToggle session={session} caption />
      <Btn icon={settingsOpen ? "chat" : "sliders"}
        title={settingsOpen ? "interaction.back" : "interaction.settings"}
        hint={settingsOpen ? "hint-chat-open" : "hint-chat-settings"}
        pressed={settingsOpen} tone={settingsOpen ? "on" : undefined}
        onClick={() => setSettingsOpen(value => !value)} />
      </div>
      <div className="lr-interaction-status" role="status">
        {state.error ? <><Glyph name="alert" size={14} /><span className={vis ? "visually-hidden" : undefined}>{t(`interaction.error.${state.error}`)}</span></>
          : !state.ready ? <><Glyph name="network" size={14} /><span className={vis ? "visually-hidden" : undefined}>{t("interaction.reconnecting")}</span></>
          : !vis && <span>{t("interaction.ephemeral")}</span>}
      </div>
      {!settingsOpen && draft && <span className="lr-chat-count" aria-hidden="true">{Array.from(draft).length} / {MAX_CHAT_CODE_POINTS}</span>}
      </footer>
    </FloatingPanel>
    <div className="lr-interaction-couch" ref={area}>
      <Couch {...couch} participantAction={{ open: openReactions, target, controls: menuId }}
        footerAction={<span className="lr-interaction-chat-toggle">
          <Btn id={`${id}-toggle`} icon="chat" title={chatOpen ? "interaction.close" : "interaction.open"} cap="interaction.open" expanded={chatOpen} controls={id}
            hint={chatOpen ? "hint-close" : "hint-chat-open"}
            tone={chatOpen ? "on" : undefined} popoverTarget={id} />
          {unread > 0 && <span className="lr-interaction-unread" aria-label={t("interaction.unread", { count: String(unread) })}>{unread}</span>}
        </span>} />
      {effects && state.reactions.map((reaction, index) => {
        const payload = reaction.payload;
        if (payload.kind !== "reaction") return null;
        // Only one's own expression replaces one's previous expression.
        // Receiving a gift never speaks for that person or hides their reaction.
        const covered = !payload.targetPeerId && !isThrow(payload.reaction) && state.reactions.slice(index + 1).some(next =>
          next.payload.kind === "reaction" && !next.payload.targetPeerId && !isThrow(next.payload.reaction) &&
          next.sender.peerId === reaction.sender.peerId);
        if (covered) return null;
        return participants.some(person => person.peerId === reaction.sender.peerId) &&
          (!payload.targetPeerId || participants.some(person => person.peerId === payload.targetPeerId)) &&
          <RoomReaction key={reaction.id} reaction={reaction} area={area} now={session.now} />;
      })}
    </div>
    <FloatingPanel id={menuId} trigger={anchor} compact anchorOnOpen icon="smile" className="lr-person-menu"
      title={t("interaction.express")} onOpenChange={open => { if (!open) setTarget(null); }}>
      <div className="lr-person-menu-body">
      <div className="lr-person-menu-target" role="group"
        aria-label={person ? t("interaction.withPerson", { name: person.displayName }) : t("interaction.express")}>
        <span className="lr-person-menu-name">
          <span className="lr-person-menu-portrait">{person
            ? <PawnSvg color={participantColor(person.peerId)} host={person.peerId === couch.host?.key} />
            : <Glyph name="smile" size={22} />}</span>
          <span>{!vis && <small>{t(target === state.peerId ? "interaction.express" : "interaction.toPerson")}</small>}
            <b>{person?.displayName ?? t("interaction.participant")}</b></span>
        </span>
      </div>
      {[false, true].filter(throws => !throws || (person && target !== state.peerId)).map(throws => <div key={String(throws)} className={throws ? "lr-reaction-props" : "lr-reaction-grid"}>
        {REACTION_IDS.filter(reaction => isThrow(reaction) === throws).map(reaction => <button key={reaction} type="button"
          aria-label={t(`interaction.reaction.${reaction}`)} aria-disabled={!canSend || !person}
          onClick={() => {
            if (!canSend || !person) return;
            session.send({ kind: "reaction", reaction, ...(target !== state.peerId ? { targetPeerId: person.peerId } : {}) });
          }}>
          <ReactionIcon reaction={reaction} />
          {throws && !vis && <span>{t(reaction === "tomato" ? "interaction.prop.tomato" : "interaction.prop.poop")}</span>}
        </button>)}
      </div>)}
      {state.error || !state.ready ? <div className="lr-interaction-status" role="status">
        <Glyph name={state.error ? "alert" : "network"} size={14} />
        <span className={vis ? "visually-hidden" : undefined}>{t(state.error ? `interaction.error.${state.error}` : "interaction.reconnecting")}</span>
      </div> : null}
      {inspect && <button type="button" className="lr-person-menu-details" onClick={() => { document.getElementById(menuId)?.hidePopover(); inspect(); }}>
        <Glyph name="gauge" size={16} />{!vis && t("host.details")}
        <span className="visually-hidden">{vis && t("host.details")}</span>
      </button>}
      {target === state.peerId && <div className="lr-interaction-effects">
        <SwitchItem checked={effects} onChange={setEffects} label={t("interaction.effects")} />
        {vis && <Glyph name="smile" size={17} />}
      </div>}
      </div>
    </FloatingPanel>
  </div>;
}
