// The couch: the roster as pawns watching the TV. Joining pawns hop in,
// self carries the green pointer, the host wears a crown (topology only).
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

const PAWN_COLORS = [
  "var(--pawn-1)", "var(--pawn-2)", "var(--pawn-3)", "var(--pawn-4)",
  "var(--pawn-5)", "var(--pawn-6)", "var(--pawn-7)", "var(--pawn-8)",
];

export function pawnColor(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PAWN_COLORS[Math.abs(hash) % PAWN_COLORS.length]!;
}

export function PawnSvg({ color, crown }: { color: string; crown?: boolean }) {
  return (
    <svg viewBox="0 0 40 48" width="40" height="48" aria-hidden="true">
      {crown ? (
        <path
          d="M14 12.5 L11.5 2 L17 6.5 L20 0 L23 6.5 L28.5 2 L26 12.5 Z"
          fill="var(--pawn-2)"
        />
      ) : null}
      <circle cx="20" cy="14" r="8.5" fill={color} />
      <path d="M5 46c0-13 6.5-17 15-17s15 4 15 17Z" fill={color} />
      <circle cx="17" cy="13" r="1.6" fill="var(--stage)" />
      <circle cx="23" cy="13" r="1.6" fill="var(--stage)" />
    </svg>
  );
}

export interface CouchEntry {
  key: string;
  name: string;
  connected: boolean;
  statusLabel?: string;
  you?: boolean;
  selectable?: boolean;
}

export function Couch({
  entries,
  selectedKey,
  onSelect,
  emptyHint,
}: {
  entries: CouchEntry[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  emptyHint?: string;
}) {
  const { vis, t } = useCopy();
  const crowded = entries.length > 10;

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
          aria-label={t("common.viewers")}
        >
          {entries.map((entry, index) => {
            const stateLabel = entry.connected
              ? t("state.peer.connected")
              : (entry.statusLabel ?? t("state.peer.connecting"));
            const label = entry.you
              ? `${entry.name} · ${t("common.you")}`
              : `${entry.name} · ${stateLabel}`;
            const inner = (
              <>
                <PawnSvg color={pawnColor(entry.key)} />
                <i
                  className={`lr-pawn-led${entry.connected ? "" : " is-wait"}`}
                  aria-hidden="true"
                />
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
            }${selectedKey === entry.key ? " is-selected" : ""}`;
            if (entry.selectable === false) {
              return (
                <span
                  key={entry.key}
                  className={className}
                  style={style}
                  title={vis ? undefined : label}
                  aria-label={label}
                >
                  {inner}
                </span>
              );
            }
            return (
              <button
                key={entry.key}
                type="button"
                className={className}
                style={style}
                title={vis ? undefined : label}
                aria-label={label}
                aria-pressed={selectedKey === entry.key}
                onClick={() => onSelect?.(entry.key)}
              >
                {inner}
              </button>
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
      {entries.length === 0 ? (
        <div
          className="lr-couch-empty"
          title={vis ? undefined : (emptyHint ?? t("host.viewers.empty"))}
        >
          <Glyph name="users" size={22} />
        </div>
      ) : null}
    </div>
  );
}
