import type { ChangeEvent } from "react";

interface ConnectionDetailsToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ConnectionDetailsToggle({
  checked,
  onChange,
}: ConnectionDetailsToggleProps) {
  return (
    <label
      className="connection-details-toggle"
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
  );
}
