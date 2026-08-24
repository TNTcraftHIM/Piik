import { Hash, MonitorUp } from "lucide-react";

import { RoomCodeEntry } from "./RoomCodeEntry";

interface StageEntryActionsProps {
  joiningRoom: boolean;
  onJoinToggle: () => void;
  onStartSharing: () => void;
}

export function StageEntryActions({
  joiningRoom,
  onJoinToggle,
  onStartSharing,
}: StageEntryActionsProps) {
  return (
    <>
      <div className="entry-actions">
        <button
          className="entry-action"
          type="button"
          title="开始分享屏幕"
          onClick={onStartSharing}
        >
          <MonitorUp size={18} aria-hidden="true" />
          开始分享
        </button>
        <span className="entry-divider" aria-hidden="true">
          或
        </span>
        <button
          className="entry-action"
          type="button"
          title="输入房间号加入观看"
          aria-expanded={joiningRoom}
          aria-controls="host-room-code-entry"
          onClick={onJoinToggle}
        >
          <Hash size={18} aria-hidden="true" />
          加入房间
        </button>
      </div>
      {joiningRoom && (
        <RoomCodeEntry id="host-room-code-entry" autoFocus inline />
      )}
    </>
  );
}
