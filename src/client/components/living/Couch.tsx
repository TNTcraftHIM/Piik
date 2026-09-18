// The roster sits in responsive couch rows. UUIDs own identity and gestures;
// self carries the green pointer, and the Host wears the gold crown.
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useElementWidth } from "../../lib/use-element-width";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import type { StatusDescriptor } from "../../ui/media-status";
import { Tooltip } from "./Tooltip";

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
}: {
  view: "host" | "viewer";
  host?: CouchHostEntry | null;
  entries: CouchEntry[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  const { t } = useCopy();
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
  const hostLabel = host
    ? [host.name, host.name === t("common.host") ? null : t("common.host"),
        host.you ? t("common.you") : null].filter(Boolean).join(" · ")
    : undefined;

  return (
    <div ref={couchRef} className="lr-couch">
      <div className="lr-couch-seating" style={{ width, minHeight: rows * 108 }}>
        <div className="lr-couch-benches" aria-hidden="true">
          {Array.from({ length: rows }, (_, row) => <svg key={row} viewBox={`0 0 ${width} 108`}>
            <path d={`M38 98v7m${width - 76} -7v7`} stroke="var(--frame)" strokeWidth="6" strokeLinecap="round" />
            <rect x="18" y="32" width={width - 36} height="65" rx="24" fill="var(--couch-dark)" />
            <rect x="28" y="24" width={width - 56} height="60" rx="23" fill="var(--couch)" />
            <rect x="28" y="76" width={width - 56} height="24" rx="10" fill="var(--couch)" />
            <path d={`M${width / 3} 79v16m${width / 3} -16v16`} stroke="var(--couch-dark)" strokeWidth="2" strokeLinecap="round" />
            <rect x="14" y="59" width="25" height="39" rx="12" fill="var(--couch-dark)" />
            <rect x={width - 39} y="59" width="25" height="39" rx="12" fill="var(--couch-dark)" />
          </svg>)}
        </div>
        <div
          className="lr-pawns"
          style={{ gridTemplateColumns: `repeat(${columns * 2}, minmax(0, 1fr))` }}
          role="group"
          aria-label={`${t("common.host")} · ${t("common.viewers")}`}
        >
          {host ? (
            <span className="lr-seat" style={seatStyle(0)}><Tooltip overflow={{ text: host.name, selector: ".lr-pawn-name" }}>
              {host.onSelect ? (
                  <button
                    type="button"
                    className={`lr-pawn is-host${host.you ? " is-you" : ""}${host.selected ? " is-selected" : ""}`}
                    aria-label={hostLabel}
                    aria-pressed={host.selected}
                    aria-controls={host.controls}
                    onClick={host.onSelect}
                  >
                    <PawnSvg color={participantColor(host.key)} identity={host.key} host />
                    <span className="lr-pawn-name">{host.name}</span>
                  </button>
                ) : (
                  <span
                    className={`lr-pawn is-host is-static${host.you ? " is-you" : ""}`}
                    role="img"
                    aria-label={hostLabel}
                  >
                    <PawnSvg color={participantColor(host.key)} identity={host.key} host />
                    <span className="lr-pawn-name">{host.name}</span>
                  </span>
                )}
            </Tooltip></span>
          ) : null}
          {entries.map((entry, index) => {
            const stateLabel = t(entry.status.labelKey);
            const label = `${entry.name}${entry.you ? ` · ${t("common.you")}` : ""} · ${stateLabel}`;
            const inner = (
              <>
                <PawnSvg color={participantColor(entry.key)} identity={entry.key} />
                {view === "host" ? <i className="lr-pawn-led" data-tone={entry.status.tone}
                  data-pulse={entry.status.pulse || undefined} aria-hidden="true" /> : null}
                <span className="lr-pawn-name">
                  {entry.name}
                </span>
              </>
            );
            const className = `lr-pawn${entry.you ? " is-you" : ""}${
              entry.selectable === false ? " is-static" : ""
            }${selectedKey === entry.key ? " is-selected" : ""}${view === "viewer" && entry.status.pulse ? " is-waiting" : ""}`;
            const pawn = entry.selectable === false ? (
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
                aria-pressed={selectedKey === entry.key}
                onClick={() => onSelect?.(entry.key)}
              >
                {inner}
              </button>
            );
            return (
              <span key={entry.key} className="lr-seat" style={seatStyle(index + (host ? 1 : 0))}><Tooltip overflow={{ text: entry.name, selector: ".lr-pawn-name" }}>
                {pawn}
              </Tooltip></span>
            );
          })}
        </div>
      </div>
      <div className="lr-couch-footer">
        <span className="lr-couch-count" role="img" aria-label={`${t("common.viewers")} ${entries.length}`}>
          <Glyph name="users" size={14} /><b>{entries.length}</b>
        </span>
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
