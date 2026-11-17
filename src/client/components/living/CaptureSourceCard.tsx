import { useId, type Ref } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import type { HintKind } from "./hints";

/** One visual source card; its caller owns discovery and preview resources. */
export function CaptureSourceCard({ title, description, action, icon, hint, preview, disabled, selected,
  nativeKey, cameraKey, buttonRef, onPreview, onSelect }: {
  title: string; description?: string; action: string; icon: GlyphName; hint?: HintKind; preview?: string | null;
  disabled?: boolean; selected?: boolean; nativeKey?: string; cameraKey?: string;
  buttonRef?: Ref<HTMLButtonElement>; onPreview?: () => void; onSelect: () => void;
}) {
  const descriptionId = useId();
  return <Tooltip {...(hint ? { kind: hint, text: title } : { overflow: { text: title, selector: ".lr-source-option-copy strong" } })} className="lr-source-option-hint">
    <button ref={buttonRef} type="button" className={`lr-source-option${preview === undefined ? " is-action" : ""}`}
      data-native-source={nativeKey} data-camera-source={cameraKey}
      aria-label={action} aria-describedby={description ? descriptionId : undefined} aria-current={selected || undefined} disabled={disabled}
      onMouseEnter={onPreview} onFocus={onPreview} onClick={onSelect}>
      {preview === undefined && <span className="lr-source-option-icon" aria-hidden="true"><Glyph name={icon} size={23} /></span>}
      <span className="lr-source-option-copy"><strong>{title}</strong>{description && <small id={descriptionId}>{description}</small>}</span>
      {preview !== undefined && <span className="lr-source-option-preview" aria-hidden="true">
        {preview ? <img src={preview} alt="" /> : <Glyph name={icon} size={23} />}
      </span>}
    </button>
  </Tooltip>;
}
