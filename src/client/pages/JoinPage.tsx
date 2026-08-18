import { Hash } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ROOM_CODE_LENGTH } from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { isValidRoomId } from "../lib/session";

export function JoinPage() {
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalizedRoomId = roomId.trim();
    if (!isValidRoomId(normalizedRoomId)) {
      setError("房间码格式不正确");
      return;
    }
    window.location.assign(`/r/${normalizedRoomId}`);
  }

  return (
    <div className="app-shell">
      <AppHeader status={null} />
      <main className="access-workspace">
        <form className="access-panel" onSubmit={join}>
          <div>
            <h1>加入分享</h1>
            <p className="section-meta">输入分享者提供的房间码</p>
          </div>
          <label className="token-field">
            <span>房间码</span>
            <span className="input-with-icon">
              <Hash size={16} aria-hidden="true" />
              <input
                value={roomId}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={ROOM_CODE_LENGTH}
                autoComplete="off"
                autoFocus
                onChange={(event) =>
                  setRoomId(event.target.value.replace(/\D/g, ""))
                }
              />
            </span>
          </label>
          {error && (
            <p className="access-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button-primary" type="submit">
            加入
          </button>
        </form>
      </main>
    </div>
  );
}
