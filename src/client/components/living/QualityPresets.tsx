import { QUALITY_PROFILES, QUALITY_PROFILE_KEYS, type QualityProfileId } from "../../media/quality";
import { useCopy } from "../../ui/copy";
import { QualityTileGlyph } from "./QualityTileGlyph";
import { Tooltip } from "./Tooltip";

export function QualityPresets({ selected, disabled = false, busy = false, onSelect }: {
  selected: QualityProfileId | null;
  disabled?: boolean;
  busy?: boolean;
  onSelect: (id: QualityProfileId) => void;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-tiles" aria-busy={busy}>
    {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map((id, index) => {
      const profile = QUALITY_PROFILES[id];
      const caption = t(QUALITY_PROFILE_KEYS[id]);
      return <Tooltip key={id} kind="hint-quality" align={index === 0 ? "start" : "center"}
        text={vis ? undefined : t("host.quality.title", { label: caption, mbps: (profile.maxBitrate / 1_000_000).toFixed(0) })}>
        <button type="button" className={`lr-tile${selected === id ? " is-selected" : ""}`}
          aria-pressed={selected === id} aria-label={caption} disabled={disabled} onClick={() => onSelect(id)}>
          <QualityTileGlyph resolution={profile.resolution} framerate={profile.maxFramerate} />
          <small>{vis ? `${profile.resolution.replace("p", "")}·${profile.maxFramerate}` : caption}</small>
        </button>
      </Tooltip>;
    })}
  </div>;
}
