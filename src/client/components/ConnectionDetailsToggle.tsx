import { Download } from "lucide-react";
import type { ChangeEvent } from "react";

interface ConnectionDetailsToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  onExport?: () => void;
}

export function ConnectionDetailsToggle({
  checked,
  onChange,
  onExport,
}: ConnectionDetailsToggleProps) {
  return (
    <div className="connection-details-toggle">
      <label
        title="展开或隐藏连接的技术指标"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.currentTarget.checked)
          }
        />
        <span>显示连接详情</span>
      </label>
      {checked && onExport && (
        <button
          className="icon-button"
          type="button"
          title="下载脱敏连接诊断"
          aria-label="下载脱敏连接诊断"
          onClick={onExport}
        >
          <Download size={17} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
