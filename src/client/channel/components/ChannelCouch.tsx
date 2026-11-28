import { memberName, duplicateMemberNames } from "../member-name";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CouchBench } from "../../components/living/CouchBench";
import { PawnSvg, type PawnState } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { RoomQuickReactions } from "../../components/living/RoomQuickReactions";
import { RoomReactionEffects } from "../../components/living/RoomReaction";
import { Tooltip } from "../../components/living/Tooltip";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { useElementWidth } from "../../lib/use-element-width";
import { joinSentences, useCopy } from "../../ui/copy";
import { useSurfaceDocument } from "../../ui/panel-window";
import { ChannelAction } from "./ChannelAction";
import { ChannelUser, personActivityBadges, personVoiceLabel } from "./ChannelUser";
import type { ParticipantActivity } from "../presentation";
import { ChannelImageDialog } from "./ChannelImageDialog";
import "./channel-couch.css";

export interface ChannelCouchPerson extends Partial<ParticipantActivity> {
  userId: string;
  name: string;
  avatar?: string;
  owner?: boolean;
  voice?: PawnState["voice"];
  collaboration?: boolean;
}

const SEAT_WIDTH = 96;
const MIN_SEAT_WIDTH = 88;
const SEAT_GUTTER = 24;
const noSubscription = () => () => {};
const noSnapshot = () => null;

/** Presence supplies people; the existing interaction session owns every effect and send. */
export function ChannelCouch({ people, selfUserId, session, className = "", floating = false, compact = false }: {
  people: readonly ChannelCouchPerson[]; selfUserId: string | null;
  session: RoomInteractionSession | null; className?: string; floating?: boolean; compact?: boolean;
}) {
  const copy = useCopy();
  const { t } = copy;
  const state = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getReactionSnapshot ?? noSnapshot, noSnapshot);
  const surfaceDocument = useSurfaceDocument();
  const [container, availableWidth] = useElementWidth();
  const guests = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ userId: string; trigger: HTMLButtonElement } | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<{ userId: string; trigger: HTMLButtonElement } | null>(null);
  const pickerId = useId();
  const self = people.find(person => person.userId === selfUserId);
  const others = people.filter(person => person.userId !== selfUserId);
  const selected = people.find(person => person.userId === target?.userId);
  const previewPerson = people.find(person => person.userId === avatarPreview?.userId);
  const width = Math.min(availableWidth, Math.max(144, people.length * SEAT_WIDTH + 2 * SEAT_GUTTER));
  const seatingWidth = width - 2 * SEAT_GUTTER;
  const seats = Math.max(1, Math.min(people.length, Math.floor(seatingWidth / MIN_SEAT_WIDTH)));
  const seatWidth = Math.min(SEAT_WIDTH, Math.max(MIN_SEAT_WIDTH, seatingWidth / seats));
  const guestSeats = Math.max(1, seats - Number(Boolean(self)));
  const guestWidth = Math.min(others.length, guestSeats) * seatWidth;
  const overflow = others.length * seatWidth > guestWidth;
  const visiblePeople = people.filter(person => {
    if (person.userId === selfUserId) return true;
    const seat = others.indexOf(person);
    return seat * seatWidth >= offset - 1 && (seat + 1) * seatWidth <= offset + guestWidth + 1;
  }).map(person => ({ peerId: person.userId }));
  useEffect(() => { setTarget(null); setAvatarPreview(null); }, [session?.key]);
  useEffect(() => { if (!previewPerson?.avatar) setAvatarPreview(null); }, [previewPerson?.avatar]);
  useEffect(() => () => {
    if (avatarPreview?.trigger.isConnected) avatarPreview.trigger.focus({ preventScroll: true });
  }, [avatarPreview]);
  useLayoutEffect(() => { setTarget(null); }, [floating, surfaceDocument]);
  useEffect(() => {
    if (target && (!selected || !target.trigger.isConnected)) setTarget(null);
  }, [target, selected]);
  function browse(direction: number) {
    setTarget(null);
    guests.current?.scrollBy({ left: direction * guestWidth });
  }
  const duplicates = duplicateMemberNames(people);
  function seat(person: ChannelCouchPerson, clipped = false) {
    const name = memberName(person.userId, person.name, duplicates.has(person.name));
    const active = target?.userId === person.userId;
    const action = t(person.userId === selfUserId ? "interaction.express" : "interaction.withPerson", { name });
    const { voice, ...activity } = person;
    const badges = personActivityBadges(activity, copy);
    const primary = badges[0];
    const labels = badges.map(badge => badge.label);
    if (person.collaboration) labels.unshift(t("remote.participant.control"));
    if (voice) labels.unshift(personVoiceLabel(voice, copy));
    const details = labels.length ? joinSentences(copy.lang, labels) : undefined;
    const inner = <>
      <PawnSvg color={participantColor(person.userId)} identity={person.userId} host={person.owner}
        avatar={person.avatar} voice={voice} collaboration={person.collaboration} activity={primary?.status ?? primary?.icon}
        additionalActivity={badges.length > (person.collaboration ? 0 : 1)} />
      <span className="lr-pawn-name">{name}</span>
    </>;
    const pawnClass = `lr-pawn${person.userId === selfUserId ? " is-you" : ""}${session ? "" : " is-static"}`;
    const overflow = { text: name, selector: ".lr-pawn-name" };
    const hint = session ? { kind: "hint-reaction-picker" as const, text: [action, ...labels].join("\n"), overflow }
      : { text: labels.length ? labels.join("\n") : undefined, overflow };
    return <span key={person.userId} className="c3-couch-seat" data-room-peer={person.userId} data-pawn-clipped={clipped || undefined}>
      <Tooltip {...hint} disabled={active} toggleOnClick={!session && !!details}>
        {session ? <button type="button" className={pawnClass} aria-label={action} aria-description={details}
          aria-expanded={active} aria-controls={pickerId}
          onClick={event => setTarget({ userId: person.userId, trigger: event.currentTarget })}>{inner}</button>
          : details ? <button type="button" className={pawnClass} aria-label={name} aria-description={details}>{inner}</button>
            : <span className={pawnClass}>{inner}</span>}
      </Tooltip>
    </span>;
  }
  return <section className={`c3-couch ${className}`} data-compact={compact || floating || undefined} aria-label={t("channel.couch.friendsInThisRoom")}
    style={{ "--c3-couch-seat": `${seatWidth}px`, "--c3-couch-gutter": `${SEAT_GUTTER}px` } as CSSProperties}>
    <div ref={container} className="c3-couch-width">
      <div ref={area} className="c3-couch-scene" style={{ width }}>
        <div className="c3-couch-bench"><CouchBench width={width / 0.75} /></div>
        <div className="c3-couch-people">
          <div ref={guests} className="c3-couch-guests" style={{ width: guestWidth }} onScroll={event => {
            setOffset(event.currentTarget.scrollLeft);
            if (target && target.userId !== selfUserId) {
              const viewport = event.currentTarget.getBoundingClientRect();
              const anchor = target.trigger.getBoundingClientRect();
              if (anchor.right <= viewport.left || anchor.left >= viewport.right) setTarget(null);
            }
          }}>{others.map((person, index) => seat(person, overflow
            && ((index + 1) * seatWidth <= offset || index * seatWidth >= offset + guestWidth)))}</div>
          {self && seat(self)}
        </div>
        {overflow && <>
          <span className="c3-couch-browse is-previous">
            <ChannelAction icon="arrowLeft" iconOnly label={t("channel.couch.seeFriendsToTheLeft")} hint="hint-reaction-picker"
              disabled={offset < 1} onClick={() => browse(-1)} />
          </span>
          <span className="c3-couch-browse is-next">
            <ChannelAction icon="arrowRight" iconOnly label={t("channel.couch.seeFriendsToTheRight")} hint="hint-reaction-picker"
              disabled={offset >= others.length * seatWidth - guestWidth - 1} onClick={() => browse(1)} />
          </span>
        </>}
      </div>
    </div>
    {area.current && state && session && createPortal(
      <RoomReactionEffects reactions={state.reactions} participants={visiblePeople} area={area} now={session.now} />,
      area.current.closest(".lr-floating-panel") ?? surfaceDocument?.body ?? area.current.ownerDocument.body,
    )}
    {target && selected && state && session && <RoomQuickReactions key={selected.userId} id={pickerId} trigger={target.trigger} side="below"
      identity={<div className="lr-person-menu-target">
        <ChannelUser id={selected.userId} name={memberName(selected.userId, selected.name, true)} avatar={selected.avatar} self={selected.userId === selfUserId}
          owner={!!selected.owner} online roomActivity={selected} collaboration={selected.collaboration}
          onPreviewAvatar={() => setAvatarPreview({ userId: selected.userId, trigger: target.trigger })} />
      </div>}
      person={{ peerId: selected.userId, displayName: memberName(selected.userId, selected.name) }} selfPeerId={selfUserId}
      hostPeerId={people.find(person => person.owner)?.userId} reactionIds={state.reactionIds}
      canSend={state.canSend}
      onSend={(reaction, targetUserId) => session.send({ kind: "reaction", reaction, ...(targetUserId ? { targetPeerId: targetUserId } : {}) })}
      onClose={() => setTarget(null)} />}
    {avatarPreview && previewPerson?.avatar && <ChannelImageDialog src={previewPerson.avatar}
      name={t("channel.user.avatar", { name: memberName(previewPerson.userId, previewPerson.name) })} onClose={() => setAvatarPreview(null)} />}
  </section>;
}
