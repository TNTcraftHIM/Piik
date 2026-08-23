import { Hash, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { roomRouteFromInput } from "../lib/session";

interface RoomCodeEntryProps {
  id: string;
  autoFocus?: boolean;
  inline?: boolean;
}

export function RoomCodeEntry({ id, autoFocus = false, inline = false }: RoomCodeEntryProps) {
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = `${id}-input`;

  function join(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const route = roomRouteFromInput(roomId);
    if (!route) {
      setError("房间号必须是 1000..9999 的四位数字");
      return;
    }
    window.location.assign(route);
  }

  return (
    <form
      id={id}
      className={inline ? "room-code-entry is-inline" : "access-panel"}
      onSubmit={join}
    >
      {!inline && (
        <div>
          <h1>加入房间</h1>
          <p className="section-meta">输入分享者提供的房间码</p>
        </div>
      )}
      <div className="token-field">
        <label className={inline ? "visually-hidden" : "field-label"} htmlFor={inputId}>
          房间码
        </label>
        <span className="input-with-icon">
          <Hash size={16} aria-hidden="true" />
          <input
            id={inputId}
            value={roomId}
            inputMode="numeric"
            autoComplete="off"
            autoFocus={autoFocus}
            placeholder={inline ? "房间码" : undefined}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => {
              setRoomId(event.target.value);
              setError(null);
            }}
          />
        </span>
      </div>
      {error && (
        <p className="access-error" role="alert">
          {error}
        </p>
      )}
      <button
        className={inline ? "icon-button room-code-submit" : "button button-primary"}
        type="submit"
        title={inline ? "加入房间" : undefined}
        aria-label={inline ? "加入房间" : undefined}
      >
        {inline ? <LogIn size={18} aria-hidden="true" /> : "加入"}
      </button>
    </form>
  );
}
