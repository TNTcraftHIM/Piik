// The couch: the roster as pawns watching the TV. Joining pawns hop in,
// self carries the green pointer, and the host carries a controller badge.
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ControllerMark } from "./ControllerMark";
import { participantColor } from "./participant-color";
import type { StatusDescriptor } from "../../ui/media-status";
import { Tooltip } from "./Tooltip";

export function PawnSvg({ color, host }: { color: string; host?: boolean }) {
  return (
    <svg viewBox="0 0 40 48" width="40" height="48" aria-hidden="true">
      <circle cx="20" cy="14" r="8.5" fill={color} />
      <path d="M5 46c0-13 6.5-17 15-17s15 4 15 17Z" fill={color} />
      <circle cx="17" cy="13" r="1.6" fill="var(--stage)" />
      <circle cx="23" cy="13" r="1.6" fill="var(--stage)" />
      {host ? <ControllerMark x={20} y={29} width={19} /> : null}
    </svg>
  );
}

export interface CouchEntry {
  key: string;
  name: string;
  status: StatusDescriptor;
  you?: boolean;
  selectable?: boolean;
}

export interface CouchHostEntry {
  key: string;
  name: string;
  online: boolean;
  you?: boolean;
  selected?: boolean;
  controls?: string;
  onSelect?: () => void;
}

export function Couch({
  view,
  host,
  entries,
  selectedKey,
  onSelect,
  emptyHint,
}: {
  view: "host" | "viewer";
  host?: CouchHostEntry | null;
  entries: CouchEntry[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  emptyHint?: string;
}) {
  const { vis, t } = useCopy();
  const crowded = entries.length + (host ? 1 : 0) > 10;
  const hostLabel = host
    ? `${host.name} · ${t("common.host")}${host.you ? ` · ${t("common.you")}` : ""} · ${t(host.online ? "state.presence.online" : "state.presence.offline")}`
    : undefined;

  return (
    <div className="lr-couch">
      <svg viewBox="0 0 640 132" aria-hidden="true">
        <rect x="70" y="110" width="18" height="16" rx="5" fill="var(--frame)" />
        <rect x="552" y="110" width="18" height="16" rx="5" fill="var(--frame)" />
        <rect x="28" y="28" width="58" height="80" rx="24" fill="var(--couch-dark)" />
        <rect x="554" y="28" width="58" height="80" rx="24" fill="var(--couch-dark)" />
        <rect x="56" y="18" width="528" height="58" rx="27" fill="var(--couch)" />
        <rect x="44" y="62" width="552" height="50" rx="23" fill="var(--couch)" />
        <path d="M212 64v46M428 64v46" stroke="var(--couch-dark)" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <div className="lr-pawns-window">
        <div
          className={`lr-pawns${crowded ? " is-crowded" : ""}`}
          role="group"
          aria-label={`${t("common.host")} · ${t("common.viewers")}`}
        >
          {host ? (
            <Tooltip text={vis ? host.name : hostLabel}>
              {host.onSelect ? (
                  <button
                    type="button"
                    className={`lr-pawn is-host${host.you ? " is-you" : ""}${host.selected ? " is-selected" : ""}`}
                    aria-label={hostLabel}
                    aria-pressed={host.selected}
                    aria-controls={host.controls}
                    onClick={host.onSelect}
                  >
                    <PawnSvg color={participantColor(host.key)} host />
                    <span className="lr-pawn-name">{host.name}</span>
                  </button>
                ) : (
                  <span
                    className={`lr-pawn is-host is-static${host.you ? " is-you" : ""}`}
                    aria-label={hostLabel}
                    tabIndex={0}
                  >
                    <PawnSvg color={participantColor(host.key)} host />
                    <span className="lr-pawn-name">{host.name}</span>
                  </span>
                )}
            </Tooltip>
          ) : null}
          {entries.map((entry, index) => {
            const stateLabel = t(entry.status.labelKey);
            const hint = entry.status.tooltip ?? entry.status.comic;
            const label = `${entry.name}${entry.you ? ` · ${t("common.you")}` : ""} · ${stateLabel}`;
            const inner = (
              <>
                <PawnSvg color={participantColor(entry.key)} />
                {view === "host" ? <i className="lr-pawn-led" data-tone={entry.status.tone}
                  data-pulse={entry.status.pulse || undefined} aria-hidden="true" /> : null}
                <span className="lr-pawn-name">
                  {entry.name}
                </span>
              </>
            );
            // Hop stagger derives from position only, so render stays pure.
            const style = {
              animationDelay: `${Math.min(index, 12) * 70}ms`,
            };
            const className = `lr-pawn${entry.you ? " is-you" : ""}${
              entry.selectable === false ? " is-static" : ""
            }${selectedKey === entry.key ? " is-selected" : ""}${view === "viewer" && entry.status.pulse ? " is-waiting" : ""}`;
            const pawn = entry.selectable === false ? (
              <span
                className={className}
                style={style}
                aria-label={label}
                tabIndex={0}
              >
                {inner}
              </span>
            ) : (
              <button
                type="button"
                className={className}
                style={style}
                aria-label={label}
                aria-pressed={selectedKey === entry.key}
                onClick={() => onSelect?.(entry.key)}
              >
                {inner}
              </button>
            );
            return (
              <Tooltip key={entry.key}
                kind={hint}
                tone={entry.status.tone}
                motion={entry.status.pulse ? "progress" : undefined}
                text={vis ? hint ? undefined : entry.name : label}
              >
                {pawn}
              </Tooltip>
            );
          })}
        </div>
      </div>
      <span
        className="lr-couch-count"
        aria-label={`${t("common.viewers")} ${entries.length}`}
      >
        <Glyph name="users" size={14} />
        <b>{entries.length}</b>
      </span>
      {entries.length === 0 && !host ? (
        <div
          className="lr-couch-empty"
          role="img"
          aria-label={emptyHint ?? t("host.viewers.empty")}
        >
          <Glyph name="users" size={22} />
        </div>
      ) : null}
    </div>
  );
}
