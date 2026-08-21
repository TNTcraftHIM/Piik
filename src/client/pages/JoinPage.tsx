import { AppHeader } from "../components/AppHeader";
import { RoomCodeEntry } from "../components/RoomCodeEntry";

export function JoinPage() {
  return (
    <div className="app-shell">
      <AppHeader status={null} />
      <main className="access-workspace">
        <RoomCodeEntry id="join-room-code" autoFocus />
      </main>
    </div>
  );
}
