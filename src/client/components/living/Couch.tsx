// The roster sits in responsive couch rows. UUIDs own identity and gestures;
// self carries the green pointer, and the Host wears the gold crown.
import type { ReactNode } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useElementWidth } from "../../lib/use-element-width";
import { PawnSvg } from "./Pawn";
import { CouchBench } from "./CouchBench";
import { participantColor } from "./participant-color";
import type { StatusDescriptor } from "../../ui/media-status";
import { Tooltip } from "./Tooltip";
import type { RoomVoiceState } from "../../../shared/protocol";
import { describeVoiceParticipant } from "../../room-voice/participant-presentation";

type VoicePresentation = ReturnType<typeof describeVoiceParticipant>;

export interface CouchEntry {
  key: string;
  name: string;
  status: StatusDescriptor;
  you?: boolean;
  selectable?: boolean;
  collaboration?: boolean;
}

export interface CouchHostEntry {
  key: string;
  name: string;
  you?: boolean;
  selected?: boolean;
  controls?: string;
  onSelect?: () => void;
}

export interface CouchProps {
  view: "host" | "viewer";
  host?: CouchHostEntry | null;
  entries: CouchEntry[];
  voiceState?: RoomVoiceState | null;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  footerAction?: ReactNode;
  participantAction?: {
    open: (key: string, trigger: HTMLButtonElement) => void;
    target: string | null;
    controls: string;
  };
}

export function Couch({
  view,
  host,
  entries,
  voiceState,
  selectedKey,
  onSelect,
  participantAction,
  footerAction,
}: CouchProps) {
  const { t, vis, lang } = useCopy();
  const comma = lang === "zh" ? "，" : ", ";
  const [couchRef, containerWidth] = useElementWidth();
  const count = entries.length + (host ? 1 : 0);
  const capacity = Math.max(2, Math.min(8, Math.floor((containerWidth - 64) / 72)));
  const rows = Math.max(1, Math.ceil(count / capacity));
  const columns = Math.max(1, Math.ceil(count / rows));
  const width = Math.min(containerWidth, Math.max(280, columns * 72 + 64));
  const seatStyle = (index: number) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    return { gridRow: row + 1, gridColumn: `${(index % columns) * 2 + 1 + columns - inRow} / span 2` };
  };
  const voiceFor = (key: string) => {
    const state = describeVoiceParticipant(voiceState?.enabled ? voiceState.members.find(member => member.peerId === key) : undefined);
    return state.appearance ? state : undefined;
  };
  const voiceLabel = (voice: VoicePresentation) => [t(voice.label), voice.appearance?.deafened && t("voice.listeningPaused")].filter(Boolean).join(comma);
  const hostVoice = host ? voiceFor(host.key) : undefined;
  const hostLabel = host
    ? [host.name, host.name === t("common.host") ? null : t("common.host"),
        host.you ? t("common.you") : null, hostVoice ? voiceLabel(hostVoice) : null].filter(Boolean).join(comma)
    : undefined;
  const collaborationLabel = () => t("remote.participant.control");
  const personHint = (name: string, voice?: VoicePresentation, collaboration?: CouchEntry["collaboration"], isHost = false) => {
    const kind = participantAction ? "hint-reaction-picker" as const : collaboration ? "hint-remote-control" as const
      : voice?.appearance?.deafened ? "hint-voice-deafen" as const
      : voice?.appearance?.microphone ? isHost ? "hint-microphone-on" as const : "hint-voice-microphone-on" as const
      : voice ? isHost ? "hint-microphone-off" as const : "hint-voice-microphone-off" as const : undefined;
    const status = [voice && voiceLabel(voice), collaboration && collaborationLabel()].filter(Boolean).join(comma);
    const overflow = { text: name, selector: ".lr-pawn-name" };
    return kind ? { kind, text: vis ? undefined : [status, participantAction && t("interaction.express")].filter(Boolean).join("\n"), overflow }
      : { overflow };
  };

  return (
    <div ref={couchRef} className="lr-couch">
      <div className="lr-couch-seating" style={{ width, minHeight: rows * 108 }}>
        <div className="lr-couch-benches" aria-hidden="true">
          {Array.from({ length: rows }, (_, row) => <CouchBench key={row} width={width} />)}
        </div>
        <div
          className="lr-pawns"
          style={{ gridTemplateColumns: `repeat(${columns * 2}, minmax(0, 1fr))` }}
          role="group"
          aria-label={[t("common.host"), t("common.viewers")].join(comma)}
        >
          {host ? (
            <span className="lr-seat" data-room-peer={host.key} style={seatStyle(0)}><Tooltip {...personHint(host.name, hostVoice, undefined, true)}>
              {host.onSelect || participantAction ? (
                  <button
                    type="button"
                    className={`lr-pawn is-host${host.you ? " is-you" : ""}${host.selected ? " is-selected" : ""}`}
                    aria-label={hostLabel}
                    aria-pressed={participantAction ? undefined : host.selected}
                    aria-expanded={participantAction ? participantAction.target === host.key : undefined}
                    aria-controls={participantAction?.controls ?? host.controls}
                    onClick={event => participantAction ? participantAction.open(host.key, event.currentTarget) : host.onSelect?.()}
                  >
                    <PawnSvg color={participantColor(host.key)} identity={host.key} host voice={hostVoice?.appearance} />
                    <span className="lr-pawn-name">{host.name}</span>
                  </button>
                ) : (
                  <span
                    className={`lr-pawn is-host is-static${host.you ? " is-you" : ""}`}
                    role="img"
                    aria-label={hostLabel}
                  >
                    <PawnSvg color={participantColor(host.key)} identity={host.key} host voice={hostVoice?.appearance} />
                    <span className="lr-pawn-name">{host.name}</span>
                  </span>
                )}
            </Tooltip></span>
          ) : null}
          {entries.map((entry, index) => {
            const stateLabel = t(entry.status.labelKey);
            const voice = voiceFor(entry.key);
            const label = [entry.name, entry.you && t("common.you"), stateLabel,
              voice && voiceLabel(voice), entry.collaboration && collaborationLabel()].filter(Boolean).join(comma);
            const inner = (
              <>
                <PawnSvg color={participantColor(entry.key)} identity={entry.key} voice={voice?.appearance} collaboration={entry.collaboration} />
                {view === "host" ? <i className="lr-pawn-led" data-tone={entry.status.tone}
                  data-pulse={entry.status.pulse || undefined} aria-hidden="true" /> : null}
                <span className="lr-pawn-name">
                  {entry.name}
                </span>
              </>
            );
            const className = `lr-pawn${entry.you ? " is-you" : ""}${
              entry.selectable === false && !participantAction ? " is-static" : ""
            }${selectedKey === entry.key ? " is-selected" : ""}${view === "viewer" && entry.status.pulse ? " is-waiting" : ""}`;
            const pawn = entry.selectable === false && !participantAction ? (
              <span
                className={className}
                role="img"
                aria-label={label}
              >
                {inner}
              </span>
            ) : (
              <button
                type="button"
                className={className}
                aria-label={label}
                aria-pressed={participantAction ? undefined : selectedKey === entry.key}
                aria-expanded={participantAction ? participantAction.target === entry.key : undefined}
                aria-controls={participantAction?.controls}
                onClick={event => participantAction ? participantAction.open(entry.key, event.currentTarget) : onSelect?.(entry.key)}
              >
                {inner}
              </button>
            );
            return (
              <span key={entry.key} className="lr-seat" data-room-peer={entry.key} style={seatStyle(index + (host ? 1 : 0))}><Tooltip {...personHint(entry.name, voice, entry.collaboration)}>
                {pawn}
              </Tooltip></span>
            );
          })}
        </div>
      </div>
      <div className={`lr-couch-footer${footerAction ? " has-action lr-media-controls" : ""}`}>
        <span className="lr-couch-count" role="img" aria-label={`${t("common.viewers")} ${entries.length}`}>
          <Glyph name="users" size={14} /><b>{entries.length}</b>
        </span>
        {footerAction}
      </div>
      {entries.length === 0 && !host ? (
        <div
          className="lr-couch-empty"
          role="img"
          aria-label={t("host.viewers.empty")}
        >
          <Glyph name="users" size={22} />
        </div>
      ) : null}
    </div>
  );
}
