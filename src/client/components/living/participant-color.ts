const PARTICIPANT_COLORS = [
  "var(--pawn-1)", "var(--pawn-2)", "var(--pawn-3)", "var(--pawn-4)",
  "var(--pawn-5)", "var(--pawn-6)", "var(--pawn-7)", "var(--pawn-8)",
];

export function participantColor(identity: string): string {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PARTICIPANT_COLORS[Math.abs(hash) % PARTICIPANT_COLORS.length]!;
}
