export async function copyRoomCode(
  roomId: string,
  writeText: (value: string) => Promise<void> = (value) =>
    navigator.clipboard.writeText(value),
): Promise<void> {
  await writeText(roomId);
}
