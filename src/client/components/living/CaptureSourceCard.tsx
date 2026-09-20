import type { Ref } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import type { HintKind } from "./hints";

/** One visual source card; its caller owns discovery and preview resources. */
export function CaptureSourceCard({ title, action, icon, hint, preview, disabled, selected,
  nativeKey, cameraKey, buttonRef, onPreview, onSelect }: {
  title: string; action: string; icon: GlyphName; hint: HintKind; preview: string | null;
  disabled?: boolean; selected?: boolean; nativeKey?: string; cameraKey?: string;
  buttonRef?: Ref<HTMLButtonElement>; onPreview?: () => void; onSelect: () => void;
}) {
  return <Tooltip kind={hint} text={title} className="lr-source-option-hint">
    <button ref={buttonRef} type="button" className="lr-source-option"
      data-native-source={nativeKey} data-camera-source={cameraKey}
      aria-label={action} aria-current={selected || undefined} disabled={disabled}
      onMouseEnter={onPreview} onFocus={onPreview} onClick={onSelect}>
      <span className="lr-source-option-copy"><strong>{title}</strong></span>
      <span className="lr-source-option-preview" aria-hidden="true">
        {preview ? <img src={preview} alt="" /> : <Glyph name={icon} size={23} />}
      </span>
    </button>
  </Tooltip>;
}
