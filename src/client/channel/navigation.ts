export function selectedRoom(): string {
  const saved = history.state?.piikChannelRoom;
  return typeof saved === "string" ? saved : new URLSearchParams(location.hash.slice(1)).get("room") ?? "";
}

export function rememberRoom(roomId: string): void {
  history.replaceState({ ...history.state, piikChannelRoom: roomId }, "");
}
